import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { ArcaSoapError, ArcaServiceError } from './errors.js';
import type { ArcaEvent, SoapCallOptions } from './types.js';

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: true,
  trimValues: true,
  numberParseOptions: {
    hex: false,
    leadingZeros: false,
    skipLike: /^\d{8,}$/,
  },
});

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  format: true,
  suppressEmptyNode: true,
});

/**
 * Parsea un string XML a objeto JS.
 */
export function parseXml(xml: string): Record<string, unknown> {
  return xmlParser.parse(xml) as Record<string, unknown>;
}

/**
 * Construye XML desde un objeto JS.
 */
export function buildXml(obj: Record<string, unknown>): string {
  return xmlBuilder.build(obj) as string;
}

/**
 * Normaliza un valor que puede ser un item, un array, o undefined/null a un array.
 * Útil para respuestas SOAP donde un solo elemento no viene wrapeado en array.
 */
export function ensureArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Busca un valor en un objeto probando múltiples keys posibles.
 * Útil para respuestas SOAP donde los prefijos de namespace varían.
 */
export function getNestedValue(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

function isRetryable(error: unknown, statusCode?: number): boolean {
  if (statusCode !== undefined && statusCode >= 500) return true;
  if (error instanceof TypeError) return true; // network errors from fetch
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof ArcaSoapError) {
    return !error.statusCode || error.statusCode >= 500;
  }
  return true; // network errors
}

// ---------------------------------------------------------------------------
// soapCall
// ---------------------------------------------------------------------------

/**
 * Llamada SOAP genérica de bajo nivel.
 * Construye el envelope SOAP, envía via fetch con timeout via AbortController,
 * y parsea la respuesta XML.
 *
 * Reintenta en errores 5xx y de red con backoff exponencial.
 */
export async function soapCall(
  endpoint: string,
  bodyContent: string,
  opts?: SoapCallOptions,
): Promise<Record<string, unknown>> {
  const timeout = opts?.timeout ?? 30_000;
  const maxRetries = opts?.retries ?? 1;
  const baseDelay = opts?.retryDelayMs ?? 1_000;
  const onEvent = opts?.onEvent;
  const methodName = opts?.methodName ?? 'unknown';

  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body>${bodyContent}</soapenv:Body>` +
    `</soapenv:Envelope>`;

  const headers: Record<string, string> = {
    'Content-Type': 'text/xml; charset=utf-8',
  };
  if (opts?.soapAction) {
    headers['SOAPAction'] = `"${opts.soapAction}"`;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      onEvent?.({
        type: 'request:retry',
        endpoint,
        method: methodName,
        attempt,
        error: lastError!,
      });
      await new Promise((r) => setTimeout(r, delay));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const startTime = Date.now();

    onEvent?.({ type: 'request:start', endpoint, method: methodName });

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: envelope,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const responseText = await response.text();

      if (!response.ok) {
        if (isRetryable(undefined, response.status) && attempt < maxRetries) {
          lastError = new ArcaSoapError(
            `HTTP ${response.status}: ${response.statusText}`,
            response.status,
          );
          continue;
        }
        const err = new ArcaSoapError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
        onEvent?.({ type: 'request:error', endpoint, method: methodName, error: err });
        throw err;
      }

      const parsed = parseXml(responseText);
      onEvent?.({ type: 'request:end', endpoint, method: methodName, durationMs });
      return parsed;
    } catch (error) {
      clearTimeout(timer);

      if (error instanceof ArcaSoapError) throw error;

      const err = error instanceof Error ? error : new Error(String(error));

      if (isRetryable(error) && attempt < maxRetries) {
        lastError = err;
        continue;
      }

      const soapErr = new ArcaSoapError(err.message);
      onEvent?.({ type: 'request:error', endpoint, method: methodName, error: soapErr });
      throw soapErr;
    }
  }

  throw lastError ?? new ArcaSoapError('Unknown SOAP call error');
}

// ---------------------------------------------------------------------------
// afipSoapCall
// ---------------------------------------------------------------------------

/**
 * Llamada SOAP de alto nivel para web services de AFIP/ARCA.
 * Construye el body con namespace y método, establece el SOAPAction,
 * llama a soapCall, y extrae el resultado del método de la respuesta.
 *
 * Detecta SOAP Faults y lanza ArcaSoapError.
 */
export async function afipSoapCall(
  endpoint: string,
  namespace: string,
  method: string,
  params: Record<string, unknown>,
  opts?: SoapCallOptions,
): Promise<Record<string, unknown>> {
  const methodBody: Record<string, unknown> = {
    [`ser:${method}`]: {
      '@_xmlns:ser': namespace,
      ...params,
    },
  };
  const bodyContent = buildXml(methodBody);

  const callOpts: SoapCallOptions = {
    ...opts,
    soapAction: '',
    methodName: method,
  };

  const parsed = await soapCall(endpoint, bodyContent, callOpts);

  // Navegar el envelope SOAP
  const envelope = getNestedValue(
    parsed,
    'soap:Envelope', 'soapenv:Envelope', 'Envelope', 'S:Envelope',
  ) as Record<string, unknown> | undefined;
  if (!envelope) {
    throw new ArcaSoapError('Respuesta SOAP inválida: falta Envelope');
  }

  const body = getNestedValue(
    envelope,
    'soap:Body', 'soapenv:Body', 'Body', 'S:Body',
  ) as Record<string, unknown> | undefined;
  if (!body) {
    throw new ArcaSoapError('Respuesta SOAP inválida: falta Body');
  }

  // Verificar SOAP Fault
  const fault = getNestedValue(
    body,
    'soap:Fault', 'soapenv:Fault', 'Fault', 'S:Fault',
  ) as Record<string, unknown> | undefined;
  if (fault) {
    const faultString = (fault['faultstring'] ?? fault['faultString'] ?? 'Error SOAP desconocido') as string;
    throw new ArcaSoapError(`SOAP Fault: ${faultString}`);
  }

  // Extraer respuesta del método
  const responseKey = `${method}Response`;
  const resultKey = `${method}Result`;
  const returnKey = `${method}Return`;

  const methodResponse = getNestedValue(
    body,
    responseKey, `ns2:${responseKey}`, `ns1:${responseKey}`,
  ) as Record<string, unknown> | undefined;
  if (!methodResponse) {
    throw new ArcaSoapError(`Respuesta SOAP inválida: falta ${responseKey}`);
  }

  // Los WS usan {method}Result (WSFE) o {method}Return (Padrón) o data directa
  const result = getNestedValue(
    methodResponse,
    resultKey, returnKey, `ns2:${returnKey}`, `ns1:${returnKey}`, 'return',
  ) as Record<string, unknown> | undefined;

  return (result ?? methodResponse) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// checkServiceErrors
// ---------------------------------------------------------------------------

/**
 * Verifica si una respuesta de un WS de ARCA contiene errores de negocio.
 * Lanza ArcaServiceError si encuentra errores.
 */
export function checkServiceErrors(
  result: Record<string, unknown>,
  serviceName: string,
): void {
  const errorsRaw = result['Errors'] ?? result['errors'] ?? result['Err'];
  if (!errorsRaw) return;

  const errorsObj = errorsRaw as Record<string, unknown>;
  const errArray = ensureArray(errorsObj['Err'] ?? errorsObj['err'] ?? errorsObj);

  const errors = errArray.map((e: unknown) => {
    const err = e as Record<string, unknown>;
    return {
      code: Number(err['Code'] ?? err['code'] ?? 0),
      msg: String(err['Msg'] ?? err['msg'] ?? 'Error desconocido'),
    };
  });

  if (errors.length > 0 && errors[0].code !== 0) {
    throw new ArcaServiceError(
      `${serviceName}: ${errors.map((e) => `[${e.code}] ${e.msg}`).join(', ')}`,
      errors,
    );
  }
}
