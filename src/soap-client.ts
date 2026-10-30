import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { ArcaSoapError, ArcaServiceError } from './errors.js';
import type { ArcaEvent, SoapCallOptions } from './types.js';

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: true,
  trimValues: true,
  numberParseOptions: {
    hex: false,
    leadingZeros: false,
    // CUIT, CAE, fechas YYYYMMDD y similares quedan como string.
    skipLike: /^\d{8,}$/,
  },
};

const xmlParser = new XMLParser(PARSER_OPTIONS);

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
// Transporte: clasificación de errores
// ---------------------------------------------------------------------------

/**
 * Parser para respuestas SOAP: igual que `parseXml` pero sin prefijos de
 * namespace (`ns2:getPersonaResponse` → `getPersonaResponse`), porque cada
 * servidor de ARCA usa prefijos distintos para los mismos elementos.
 */
const soapResponseParser = new XMLParser({ ...PARSER_OPTIONS, removeNSPrefix: true });

/**
 * Emite un evento sin que un error del callback del usuario afecte la
 * operación (una respuesta recibida nunca debe convertirse en error por un
 * logger que falla).
 */
export function safeEmit(onEvent: ((event: ArcaEvent) => void) | undefined, event: ArcaEvent): void {
  try {
    onEvent?.(event);
  } catch {
    // Ignorado a propósito.
  }
}

/**
 * Códigos de error de red que garantizan que el request no llegó al servidor
 * (falla de DNS, conexión rechazada, handshake TLS fallido).
 */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_SSL_DH_KEY_TOO_SMALL',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

function networkErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('#text' in obj) return String(obj['#text']);
    // SOAP 1.2: <Reason><Text>...</Text></Reason>, <Code><Value>...</Value></Code>
    return textOf(obj['Text'] ?? obj['Value']);
  }
  return String(value);
}

/** Extrae `faultcode`/`faultstring` de una respuesta SOAP ya parseada (sin prefijos). */
function extractFault(parsed: Record<string, unknown>): { faultCode?: string; faultString: string } | undefined {
  const envelope = parsed['Envelope'] as Record<string, unknown> | undefined;
  const body = envelope?.['Body'] as Record<string, unknown> | undefined;
  const fault = body?.['Fault'] as Record<string, unknown> | undefined;
  if (!fault) return undefined;
  return {
    faultCode: textOf(fault['faultcode'] ?? fault['Code']),
    faultString: textOf(fault['faultstring'] ?? fault['Reason']) ?? 'SOAP Fault desconocido',
  };
}

function parseResponseDate(header: string | null): Date | undefined {
  if (!header) return undefined;
  const d = new Date(header);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Un error es reintentable (solo en consultas) si es transitorio: red, timeout,
 * respuesta cortada o ilegible, o un 5xx sin SOAP Fault (502/503/504 de un
 * proxy). Un SOAP Fault es una respuesta determinística del servicio y un 4xx
 * un rechazo del request: no se reintentan.
 */
function isRetryable(error: ArcaSoapError): boolean {
  if (error.aborted) return false;
  if (error.faultString !== undefined) return false;
  const status = error.statusCode;
  return status === undefined || status < 400 || status >= 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// soapCall
// ---------------------------------------------------------------------------

/**
 * Llamada SOAP genérica de bajo nivel.
 * Construye el envelope SOAP, envía via fetch con timeout, y parsea la
 * respuesta XML. Los prefijos de namespace se eliminan de la respuesta
 * parseada (`soap:Envelope` → `Envelope`).
 *
 * - `kind: 'consulta'` (default): reintenta errores de red, timeouts y 5xx
 *   sin SOAP Fault, con backoff exponencial.
 * - `kind: 'emision'`: nunca reintenta. Si no hay certeza de que el request no
 *   se procesó, el error tiene `uncertain: true`.
 *
 * Los SOAP Faults (aunque vengan con HTTP 500) se lanzan como `ArcaSoapError`
 * con `faultCode`/`faultString`. Todos los errores con respuesta incluyen
 * `responseDate` (header `Date` del servidor).
 */
export async function soapCall(
  endpoint: string,
  bodyContent: string,
  opts?: SoapCallOptions,
): Promise<Record<string, unknown>> {
  const timeout = opts?.timeout ?? 30_000;
  const kind = opts?.kind ?? 'consulta';
  const maxRetries = kind === 'emision' ? 0 : (opts?.retries ?? 1);
  const baseDelay = opts?.retryDelayMs ?? 1_000;
  const onEvent = opts?.onEvent;
  const methodName = opts?.methodName ?? 'unknown';
  const externalSignal = opts?.signal;

  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body>${bodyContent}</soapenv:Body>` +
    `</soapenv:Envelope>`;

  const headers: Record<string, string> = {
    'Content-Type': 'text/xml; charset=utf-8',
    SOAPAction: `"${opts?.soapAction ?? ''}"`,
  };

  let lastError: ArcaSoapError | undefined;

  for (let attempt = 0; ; attempt++) {
    if (lastError) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      safeEmit(onEvent, {
        type: 'request:retry',
        endpoint,
        method: methodName,
        attempt,
        error: lastError,
      });
      try {
        await sleep(delay, externalSignal);
      } catch (reason) {
        throw abortedBeforeSend(methodName, reason);
      }
    }

    // Abortado antes de enviar: certeza de que no se procesó.
    if (externalSignal?.aborted) {
      throw abortedBeforeSend(methodName, externalSignal.reason);
    }

    const error = await attemptOnce();
    if (!(error instanceof ArcaSoapError)) return error;

    lastError = error;
    if (attempt < maxRetries && isRetryable(error)) continue;

    safeEmit(onEvent, { type: 'request:error', endpoint, method: methodName, error });
    throw error;
  }

  /** Devuelve la respuesta parseada, o el error (sin lanzarlo) para decidir el reintento. */
  async function attemptOnce(): Promise<Record<string, unknown> | ArcaSoapError> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    const startTime = Date.now();
    safeEmit(onEvent, { type: 'request:start', endpoint, method: methodName });

    try {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: envelope,
          signal: controller.signal,
        });
      } catch (err) {
        return fetchError(err, timedOut);
      }

      let responseText: string;
      try {
        responseText = await response.text();
      } catch (err) {
        // La respuesta empezó a llegar: el servidor procesó (o está procesando) el request.
        const base = fetchError(err, timedOut);
        return new ArcaSoapError(base.message, {
          cause: err,
          statusCode: response.status,
          responseDate: parseResponseDate(response.headers.get('date')),
          uncertain: true,
          aborted: base.aborted,
        });
      }

      const responseDate = parseResponseDate(response.headers.get('date'));
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = soapResponseParser.parse(responseText) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }

      if (!response.ok) {
        const fault = parsed ? extractFault(parsed) : undefined;
        const message = fault
          ? `SOAP Fault: ${fault.faultString}`
          : `HTTP ${response.status}: ${response.statusText}`;
        return new ArcaSoapError(message, {
          statusCode: response.status,
          faultCode: fault?.faultCode,
          faultString: fault?.faultString,
          responseDate,
          // 4xx: el servidor rechazó el request sin procesarlo.
          uncertain: response.status >= 500,
        });
      }

      if (!parsed) {
        return new ArcaSoapError(`Respuesta XML inválida de ${methodName}`, {
          statusCode: response.status,
          responseDate,
          uncertain: true,
        });
      }

      safeEmit(onEvent, { type: 'request:end', endpoint, method: methodName, durationMs: Date.now() - startTime });
      return parsed;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  function fetchError(err: unknown, timedOut: boolean): ArcaSoapError {
    if (timedOut) {
      return new ArcaSoapError(`Timeout después de ${timeout}ms llamando a ${methodName}`, {
        cause: err,
        uncertain: true,
      });
    }
    if (externalSignal?.aborted) {
      return new ArcaSoapError(`Llamada a ${methodName} abortada`, {
        cause: err,
        uncertain: true,
        aborted: true,
      });
    }
    const code = networkErrorCode(err);
    const detail = err instanceof Error ? err.message : String(err);
    return new ArcaSoapError(`Error de red llamando a ${methodName}: ${detail}${code ? ` (${code})` : ''}`, {
      cause: err,
      uncertain: !(code !== undefined && NOT_SENT_CODES.has(code)),
    });
  }
}

/** Error para una llamada cancelada por el caller antes de enviarse (no se procesó nada). */
export function abortedBeforeSend(methodName: string, reason: unknown): ArcaSoapError {
  return new ArcaSoapError(`Llamada a ${methodName} abortada antes de enviarse`, {
    cause: reason,
    uncertain: false,
    aborted: true,
  });
}

// ---------------------------------------------------------------------------
// afipSoapCall
// ---------------------------------------------------------------------------

function findKey(obj: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    if (name in obj) return name;
  }
  return undefined;
}

/**
 * Llamada SOAP de alto nivel para web services de AFIP/ARCA con elementos
 * hijos sin namespace (`elementFormDefault="unqualified"`, ej: Padrón, WSAA).
 * Construye el body con el método prefijado (`<ser:metodo xmlns:ser="...">`)
 * para que los parámetros no hereden el namespace, llama a soapCall, y extrae
 * el resultado del método de la respuesta.
 *
 * El resultado se desenvuelve si el método responde con un único elemento
 * `{method}Result`, `{method}Return`, `return` o `*Return` (ej: `personaReturn`).
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

  const parsed = await soapCall(endpoint, bodyContent, {
    soapAction: '',
    ...opts,
    methodName: method,
  });

  return extractMethodResult(parsed, method);
}

/**
 * Extrae el resultado de un método de una respuesta SOAP parseada por `soapCall`.
 * Lanza ArcaSoapError si la respuesta no tiene la forma esperada o es un Fault.
 */
export function extractMethodResult(
  parsed: Record<string, unknown>,
  method: string,
): Record<string, unknown> {
  const invalid = (msg: string) =>
    new ArcaSoapError(`Respuesta SOAP inválida: ${msg}`, { uncertain: true });

  const envelope = getNestedValue(parsed, 'Envelope', 'soap:Envelope', 'soapenv:Envelope', 'S:Envelope') as
    | Record<string, unknown>
    | undefined;
  if (!envelope) throw invalid('falta Envelope');

  const body = getNestedValue(envelope, 'Body', 'soap:Body', 'soapenv:Body', 'S:Body') as
    | Record<string, unknown>
    | undefined;
  if (!body) throw invalid('falta Body');

  const fault = extractFault({ Envelope: { Body: body } });
  if (fault) {
    throw new ArcaSoapError(`SOAP Fault: ${fault.faultString}`, {
      faultCode: fault.faultCode,
      faultString: fault.faultString,
      uncertain: true,
    });
  }

  const responseKey = `${method}Response`;
  const responseName = findKey(body, responseKey) ?? Object.keys(body).find((k) => k.endsWith(`:${responseKey}`));
  const methodResponse = responseName ? body[responseName] : undefined;
  if (methodResponse === undefined || methodResponse === null) throw invalid(`falta ${responseKey}`);
  if (typeof methodResponse !== 'object') return {};

  const response = methodResponse as Record<string, unknown>;
  const childKeys = Object.keys(response).filter((k) => !k.startsWith('@_'));
  const resultName =
    findKey(response, `${method}Result`, `${method}Return`, 'return') ??
    (childKeys.length === 1 && /(Return|Result)$/.test(childKeys[0]) ? childKeys[0] : undefined);

  const result = resultName ? response[resultName] : undefined;
  if (result !== undefined && result !== null && typeof result === 'object') {
    return result as Record<string, unknown>;
  }
  return response;
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
