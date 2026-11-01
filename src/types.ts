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
  /**
   * Devuelve el ticket guardado, o `null`. El segundo parámetro es opcional: si
   * el storage detecta un problema que resuelve por su cuenta (ej: un archivo
   * corrupto que descarta), puede informarlo con `options.onError` sin lanzar.
   */
  get(key: string, options?: TicketStorageGetOptions): Promise<AccessTicket | null>;
  set(key: string, ticket: AccessTicket): Promise<void>;
  delete?(key: string): Promise<void>;
}

/** Opciones que `WsaaClient` pasa a `TicketStorage.get`. */
export interface TicketStorageGetOptions {
  /**
   * Informa un error que el storage resolvió sin lanzar (ej: ticket corrupto
   * descartado). `WsaaClient` lo emite como `auth:storage-error` (operation `get`).
   */
  onError?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Transporte HTTP
// ---------------------------------------------------------------------------

/**
 * Uso del transporte TLS "legacy" (`node:https` con `ciphers: 'DEFAULT@SECLEVEL=1'`).
 *
 * Algunos hosts de producción de ARCA (ej: `servicios1.afip.gov.ar`, WSFEv1 y
 * WSCDC) negocian Diffie-Hellman de 1024 bits, que Node >= 17 rechaza con
 * `ERR_SSL_DH_KEY_TOO_SMALL`.
 *
 * - `auto` (default): usa `fetch`; si el handshake falla por ese motivo,
 *   reintenta el mismo request con el transporte legacy (es seguro: el request
 *   no llegó a enviarse) y recuerda el host para las siguientes llamadas.
 * - `never`: nunca usa el transporte legacy.
 * - `always`: usa siempre el transporte legacy.
 *
 * Solo aplica al `fetch` por defecto: con un `fetch` inyectado no hay fallback.
 */
export type LegacyTlsMode = 'auto' | 'never' | 'always';

// ---------------------------------------------------------------------------
// Configuración base
// ---------------------------------------------------------------------------

/**
 * Configuración común a todos los SDKs de ARCA. Cada SDK la extiende con sus
 * propias opciones.
 */
export interface ArcaBaseConfig {
  /** Contenido del certificado X.509 en formato PEM */
  cert: string;
  /** Contenido de la clave privada en formato PEM */
  key: string;
  /** CUIT del contribuyente que opera (representado), con o sin guiones. */
  cuit: number | string;
  /** Usar entorno de producción (default: false = testing/homologación) */
  production?: boolean;
  /** Timeout para requests HTTP en milisegundos (default: 30000) */
  timeout?: number;
  /** Cantidad de reintentos en consultas ante errores transitorios (default: 1). Las emisiones nunca se reintentan. */
  retries?: number;
  /** Delay inicial entre reintentos en milisegundos, se duplica con cada intento (default: 1000) */
  retryDelayMs?: number;
  /** Tiempo de vida del Ticket de Acceso solicitado a WSAA, en minutos (default: 720 = 12 horas). */
  tokenTTLMinutes?: number;
  /** Callback para eventos del SDK (auth, requests, retries). */
  onEvent?: (event: ArcaEvent) => void;
  /** Storage persistente de Tickets de Acceso (ver `TicketStorage`). Recomendado en producción. */
  ticketStorage?: TicketStorage;
  /** Diferencia entre el reloj de ARCA y el local, en ms (`relojARCA - relojLocal`). Default: 0. */
  clockOffsetMs?: number;
  /** Ajustar automáticamente el reloj si WSAA rechaza el TRA por desfase (default: true). */
  autoClockSkew?: boolean;
  /**
   * Tras un login WSAA fallido, durante cuántos ms se rechazan nuevos logins
   * para el mismo servicio sin llamar a WSAA (default: 60000; 0 lo desactiva).
   */
  loginErrorCooldownMs?: number;
  /** `fetch` propio para todos los requests HTTP (proxy, mTLS, tests). Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Uso del transporte TLS legacy para hosts con DH de 1024 bits (default: `auto`). */
  legacyTls?: LegacyTlsMode;
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
  /**
   * `fetch` propio (proxy, mTLS, tests). Default: `globalThis.fetch`. Con un
   * `fetch` inyectado no se usa el fallback de TLS legacy.
   */
  fetch?: typeof fetch;
  /** Uso del transporte TLS legacy para hosts con DH de 1024 bits (default: `auto`). */
  legacyTls?: LegacyTlsMode;
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
