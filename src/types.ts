// ---------------------------------------------------------------------------
// Autenticación
// ---------------------------------------------------------------------------

export interface AccessTicket {
  token: string;
  sign: string;
  expirationTime: Date;
}

// ---------------------------------------------------------------------------
// Configuración base
// ---------------------------------------------------------------------------

export interface ArcaBaseConfig {
  /** Contenido del certificado X.509 en formato PEM */
  cert: string;
  /** Contenido de la clave privada en formato PEM */
  key: string;
  /** Usar entorno de producción (default: false = testing/homologación) */
  production?: boolean;
  /** Timeout para requests HTTP en milisegundos (default: 30000) */
  timeout?: number;
  /** Cantidad de reintentos en caso de error transitorio (default: 1) */
  retries?: number;
  /** Delay inicial entre reintentos en milisegundos, se duplica con cada intento (default: 1000) */
  retryDelayMs?: number;
  /** Callback para eventos del SDK (auth, requests, retries). */
  onEvent?: (event: ArcaEvent) => void;
}

// ---------------------------------------------------------------------------
// SOAP call options
// ---------------------------------------------------------------------------

export interface SoapCallOptions {
  /** Timeout en milisegundos (default: 30000) */
  timeout?: number;
  /** Cantidad de reintentos (default: 1) */
  retries?: number;
  /** Delay base en milisegundos para backoff exponencial (default: 1000) */
  retryDelayMs?: number;
  /** Valor del header SOAPAction */
  soapAction?: string;
  /** Callback de eventos */
  onEvent?: (event: ArcaEvent) => void;
  /** Nombre del método para reportar eventos */
  methodName?: string;
}

// ---------------------------------------------------------------------------
// Server status
// ---------------------------------------------------------------------------

export interface ServerStatus {
  appserver: string;
  dbserver: string;
  authserver: string;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export type ArcaEvent =
  | { type: 'auth:login'; service: string; durationMs?: number }
  | { type: 'auth:cache-hit'; service: string }
  | { type: 'request:start'; method: string; endpoint: string }
  | { type: 'request:end'; method: string; endpoint: string; durationMs: number }
  | { type: 'request:retry'; method: string; endpoint: string; attempt: number; error: Error | string }
  | { type: 'request:error'; method: string; endpoint: string; error: Error | string };
