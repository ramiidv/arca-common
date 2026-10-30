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
  /** Cantidad de reintentos en consultas ante errores transitorios (default: 1). Las emisiones nunca se reintentan. */
  retries?: number;
  /** Delay inicial entre reintentos en milisegundos, se duplica con cada intento (default: 1000) */
  retryDelayMs?: number;
  /** Callback para eventos del SDK (auth, requests, retries). */
  onEvent?: (event: ArcaEvent) => void;
}

// ---------------------------------------------------------------------------
// SOAP call options
// ---------------------------------------------------------------------------

/**
 * Tipo de operación SOAP.
 *
 * - `consulta`: no cambia estado en ARCA. Se puede reintentar.
 * - `emision`: puede crear un comprobante (ej: FECAESolicitar). Nunca se
 *   reintenta: si la respuesta se pierde, el error tiene `uncertain: true`.
 */
export type SoapOperationKind = 'consulta' | 'emision';

export interface SoapCallOptions {
  /** Timeout en milisegundos (default: 30000) */
  timeout?: number;
  /** Cantidad de reintentos para consultas (default: 1). Se ignora en emisiones. */
  retries?: number;
  /** Delay base en milisegundos para backoff exponencial (default: 1000) */
  retryDelayMs?: number;
  /** Valor del header SOAPAction */
  soapAction?: string;
  /** Callback de eventos */
  onEvent?: (event: ArcaEvent) => void;
  /** Nombre del método para reportar eventos */
  methodName?: string;
  /** Tipo de operación (default: `consulta`). */
  kind?: SoapOperationKind;
  /** Permite cancelar el request. */
  signal?: AbortSignal;
}

/** Opciones por llamada que aceptan los métodos públicos de los SDKs. */
export interface CallOptions {
  /**
   * Permite cancelar la llamada. Ojo: abortar una emisión después de enviada
   * deja el resultado incierto (el SDK lo informa como tal).
   */
  signal?: AbortSignal;
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
  | { type: 'auth:cache-hit'; service: string; source?: 'memory' | 'storage' }
  | { type: 'auth:clock-skew'; service: string; offsetMs: number; previousOffsetMs: number }
  | { type: 'auth:storage-error'; service: string; operation: 'get' | 'set' | 'delete'; error: Error | string }
  | { type: 'request:start'; method: string; endpoint: string }
  | { type: 'request:end'; method: string; endpoint: string; durationMs: number }
  | { type: 'request:retry'; method: string; endpoint: string; attempt: number; error: Error | string }
  | { type: 'request:error'; method: string; endpoint: string; error: Error | string };
