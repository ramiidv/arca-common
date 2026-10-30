// ---------------------------------------------------------------------------
// Autenticación
// ---------------------------------------------------------------------------

/**
 * Ticket de Acceso (TA) de WSAA.
 *
 * Es serializable a JSON tal cual (`JSON.stringify` / `JSON.parse`): las fechas
 * son strings ISO-8601 en UTC. Se puede guardar en una DB, Redis, un archivo, etc.
 */
export interface AccessTicket {
  token: string;
  sign: string;
  /** Vencimiento del TA (ISO-8601, UTC), según el reloj de WSAA. */
  expirationTime: string;
  /** Emisión del TA (ISO-8601, UTC), según el reloj de WSAA. */
  generationTime?: string;
  /** Servicio para el que se emitió el TA (ej: "wsfe"). */
  service?: string;
}

/**
 * Almacenamiento persistente de Tickets de Acceso.
 *
 * WSAA rechaza un login si ya existe un TA vigente para el mismo certificado y
 * servicio, así que un proceso que se reinicia necesita recuperar el TA que
 * obtuvo antes. Implementá esta interfaz sobre tu DB, Redis, archivo, etc.
 *
 * La `key` la arma `WsaaClient` e identifica entorno + certificado + servicio
 * (ej: `"homo:3f9a0c1b2d4e5f60:wsfe"`), así que un mismo storage se puede
 * compartir entre varios certificados, CUITs y entornos sin que se pisen.
 *
 * Los tickets que se guardan son JSON puro. `get` puede devolver un ticket
 * vencido: el cliente lo descarta.
 */
export interface TicketStorage {
  get(key: string): Promise<AccessTicket | null>;
  set(key: string, ticket: AccessTicket): Promise<void>;
  delete?(key: string): Promise<void>;
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
