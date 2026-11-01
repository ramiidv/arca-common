import { request as httpsRequest } from 'node:https';

/**
 * Transporte HTTP alternativo basado en `node:https` con `ciphers:
 * 'DEFAULT@SECLEVEL=1'`, para hosts de ARCA que todavía negocian
 * Diffie-Hellman de 1024 bits (ej: `servicios1.afip.gov.ar`) y que `fetch`
 * (OpenSSL con SECLEVEL=2) rechaza con `ERR_SSL_DH_KEY_TOO_SMALL`.
 *
 * Uso interno de `soapCall`. Está en un módulo propio para poder reemplazarlo
 * en los tests (`vi.mock('../src/legacy-tls.js')`).
 */

export interface LegacyTlsRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface LegacyTlsResponse {
  status: number;
  statusText: string;
  /** Headers de la respuesta, con nombres en minúscula (al menos `date`). */
  headers: Record<string, string>;
  body: string;
}

/**
 * Error de lectura de la respuesta (el servidor ya respondió, pero el body se
 * cortó). Lleva el status para que el caller lo clasifique como incierto.
 */
export class LegacyTlsResponseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers: Record<string, string>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LegacyTlsResponseError';
  }
}

export function legacyTlsRequest(url: string, init: LegacyTlsRequest): Promise<LegacyTlsResponse> {
  return new Promise<LegacyTlsResponse>((resolve, reject) => {
    const body = Buffer.from(init.body, 'utf8');
    const req = httpsRequest(
      url,
      {
        method: init.method,
        headers: { ...init.headers, 'Content-Length': String(body.length) },
        ciphers: 'DEFAULT@SECLEVEL=1',
        signal: init.signal,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status,
            statusText: res.statusMessage ?? '',
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (err) => {
          reject(new LegacyTlsResponseError(err.message, status, headers, { cause: err }));
        });
        res.on('aborted', () => {
          reject(new LegacyTlsResponseError('Respuesta cortada', status, headers));
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
