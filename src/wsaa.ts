import { createHash, randomInt } from 'node:crypto';
import forge from 'node-forge';
import { ArcaAuthError, ArcaSoapError, ArcaTicketVigenteError } from './errors.js';
import { soapCall, parseXml, buildXml, extractMethodResult, safeEmit, abortedBeforeSend } from './soap-client.js';
import { normalizeAccessTicket } from './ticket-storage.js';
import type { AccessTicket, ArcaEvent, CallOptions, LegacyTlsMode, SoapCallOptions, TicketStorage } from './types.js';
import { WSAA_ENDPOINTS, WSAA_NAMESPACE } from './constants.js';

/** Margen de seguridad antes de considerar un token expirado (2 minutos). */
const EXPIRY_MARGIN_MS = 2 * 60_000;
/** Antigüedad del `generationTime` del TRA, para tolerar relojes levemente adelantados. */
const TRA_GENERATION_OFFSET_MS = 2 * 60_000;
/** Vida por defecto del ticket solicitado (12 horas, el máximo habitual de WSAA). */
const DEFAULT_TOKEN_TTL_MINUTES = 720;
/** Espera por defecto antes de volver a intentar un login fallido (la spec de WSAA pide no reintentar enseguida). */
const DEFAULT_LOGIN_ERROR_COOLDOWN_MS = 60_000;
/**
 * Esperas (ms) entre relecturas del storage tras `coe.alreadyAuthenticated`:
 * otro proceso pudo haber obtenido el TA y estar por guardarlo.
 */
const ALREADY_AUTHENTICATED_REREAD_DELAYS_MS = [0, 250, 750];

export interface WsaaClientConfig {
  /** Certificado X.509 en formato PEM */
  cert: string;
  /** Clave privada RSA en formato PEM */
  key: string;
  /** Usar producción (default: false = testing/homologación) */
  production?: boolean;
  /** URL del endpoint WSAA. Si se provee, ignora `production`. */
  endpoint?: string;
  /** Tiempo de vida del token en minutos (default: 720 = 12 horas) */
  tokenTTLMinutes?: number;
  /** Timeout en milisegundos (default: 30000) */
  timeout?: number;
  /** Reintentos en caso de error transitorio (default: 1) */
  retries?: number;
  /** Delay base para backoff exponencial en milisegundos (default: 1000) */
  retryDelayMs?: number;
  /** Callback de eventos */
  onEvent?: (event: ArcaEvent) => void;
  /**
   * Storage persistente de Tickets de Acceso. Sin storage, un reinicio del
   * proceso pierde el TA y WSAA rechaza el login siguiente hasta que venza
   * (ver `ArcaTicketVigenteError`). Recomendado en producción.
   */
  ticketStorage?: TicketStorage;
  /**
   * Diferencia entre el reloj de ARCA y el local, en ms (`relojARCA - relojLocal`).
   * Se aplica al armar el TRA y al evaluar el vencimiento de los tickets. Default: 0.
   */
  clockOffsetMs?: number;
  /**
   * Si WSAA rechaza el TRA por `generationTime`/`expirationTime` (reloj local
   * desfasado), calcula el offset desde el header `Date` de la respuesta,
   * reintenta el login una vez y emite `auth:clock-skew`. Default: true.
   */
  autoClockSkew?: boolean;
  /**
   * Tras un login fallido (salvo TA vigente, desfase de reloj, abort o error de
   * red sin enviar), durante cuántos ms `getAccessTicket` rechaza enseguida
   * con `ArcaAuthError` (con `cause` = el error original) sin llamar a WSAA,
   * como pide la especificación. Default: 60000; 0 lo desactiva.
   * `clearTicket`/`clearAllTickets` limpian la espera.
   */
  loginErrorCooldownMs?: number;
  /** `fetch` propio para los requests a WSAA. Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Uso del transporte TLS legacy (ver `SoapCallOptions.legacyTls`). Default: `auto`. */
  legacyTls?: LegacyTlsMode;
}

/**
 * Cliente para el WSAA (Web Service de Autenticación y Autorización) de ARCA.
 * Maneja la creación del TRA, firma CMS/PKCS#7, login, y cache de tokens.
 *
 * Orden de búsqueda de un ticket: memoria → `ticketStorage` → login.
 * Los logins concurrentes para el mismo servicio se deduplican.
 */
export class WsaaClient {
  // Campos privados de ES (#): no aparecen en `util.inspect` ni en `JSON.stringify`.
  readonly #cert: string;
  readonly #key: string;
  /** Tickets en memoria (token y sign son credenciales). */
  readonly #ticketCache = new Map<string, AccessTicket>();
  private readonly endpoint: string;
  private readonly tokenTTLMinutes: number;
  private readonly soapOpts: Pick<SoapCallOptions, 'timeout' | 'retries' | 'retryDelayMs' | 'fetch' | 'legacyTls'>;
  private readonly onEvent?: (event: ArcaEvent) => void;
  private readonly storage?: TicketStorage;
  private readonly autoClockSkew: boolean;
  private readonly keyPrefix: string;
  private readonly loginErrorCooldownMs: number;
  private offsetMs: number;

  private readonly pendingLogins = new Map<string, Promise<AccessTicket>>();
  /**
   * Servicios para los que WSAA rechazó un login nuevo (alreadyAuthenticated)
   * mientras el ticket actual seguía vigente: hasta que venza, se usa ese
   * ticket en lugar de reintentar el login.
   */
  private readonly loginBlockedUntil = new Map<string, number>();
  /** Último login fallido por servicio, mientras dura `loginErrorCooldownMs`. */
  private readonly loginFailures = new Map<string, { until: number; error: unknown }>();

  constructor(config: WsaaClientConfig) {
    this.#cert = config.cert;
    this.#key = config.key;
    this.endpoint = config.endpoint
      ?? (config.production ? WSAA_ENDPOINTS.production : WSAA_ENDPOINTS.testing);
    this.tokenTTLMinutes = config.tokenTTLMinutes ?? DEFAULT_TOKEN_TTL_MINUTES;
    this.onEvent = config.onEvent;
    this.storage = config.ticketStorage;
    this.autoClockSkew = config.autoClockSkew ?? true;
    this.offsetMs = config.clockOffsetMs ?? 0;
    this.loginErrorCooldownMs = Math.max(0, config.loginErrorCooldownMs ?? DEFAULT_LOGIN_ERROR_COOLDOWN_MS);
    this.soapOpts = {
      timeout: config.timeout,
      retries: config.retries,
      retryDelayMs: config.retryDelayMs,
      fetch: config.fetch,
      legacyTls: config.legacyTls,
    };
    this.keyPrefix = `${environmentLabel(this.endpoint)}:${certFingerprint(this.#cert)}`;
  }

  /** Offset de reloj vigente (`relojARCA - relojLocal`, en ms). Puede cambiar si `autoClockSkew` lo ajusta. */
  get clockOffsetMs(): number {
    return this.offsetMs;
  }

  /** Hora actual según el reloj de ARCA (hora local + `clockOffsetMs`). */
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  /**
   * Key con la que se guarda el ticket de `service` en el `ticketStorage`:
   * `"{entorno}:{huella del certificado}:{servicio}"`.
   */
  ticketKey(service: string): string {
    return `${this.keyPrefix}:${service}`;
  }

  /**
   * Obtiene un Ticket de Acceso (TA) para el servicio indicado.
   *
   * El `signal` solo cancela la espera de este caller: un login en curso no se
   * aborta, porque un login que llega a WSAA y cuya respuesta se pierde deja
   * el certificado bloqueado hasta que el TA venza.
   */
  async getAccessTicket(service: string, opts?: CallOptions): Promise<AccessTicket> {
    const cached = this.#ticketCache.get(service);
    if (cached && (this.isTicketValid(cached) || this.isLoginBlocked(service, cached))) {
      safeEmit(this.onEvent, { type: 'auth:cache-hit', service, source: 'memory' });
      return cached;
    }

    let pending = this.pendingLogins.get(service);
    if (!pending) {
      pending = this.resolveTicket(service).finally(() => {
        this.pendingLogins.delete(service);
      });
      this.pendingLogins.set(service, pending);
    }
    return raceWithSignal(pending, opts?.signal, (reason) => abortedBeforeSend('getAccessTicket', reason));
  }

  /**
   * Invalida el ticket de un servicio, en memoria y en el `ticketStorage`.
   */
  async clearTicket(service: string): Promise<void> {
    this.#ticketCache.delete(service);
    this.loginBlockedUntil.delete(service);
    this.loginFailures.delete(service);
    await this.deleteFromStorage(service);
  }

  /**
   * Invalida todos los tickets que este cliente conoce (los que pasaron por
   * memoria en este proceso), también en el `ticketStorage`.
   */
  async clearAllTickets(): Promise<void> {
    const services = [...this.#ticketCache.keys()];
    this.#ticketCache.clear();
    this.loginBlockedUntil.clear();
    this.loginFailures.clear();
    await Promise.all(services.map((s) => this.deleteFromStorage(s)));
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Vigente con margen: se usa sin intentar renovarlo. */
  private isTicketValid(ticket: AccessTicket): boolean {
    return this.msToExpiry(ticket) > EXPIRY_MARGIN_MS;
  }

  /** Todavía no venció (sin margen): WSAA lo sigue aceptando. */
  private isTicketUsable(ticket: AccessTicket): boolean {
    return this.msToExpiry(ticket) > 0;
  }

  private msToExpiry(ticket: AccessTicket): number {
    const expires = Date.parse(ticket.expirationTime);
    return Number.isFinite(expires) ? expires - this.now().getTime() : -Infinity;
  }

  private isLoginBlocked(service: string, ticket: AccessTicket): boolean {
    const until = this.loginBlockedUntil.get(service);
    return until !== undefined && until > Date.now() && this.isTicketUsable(ticket);
  }

  private async resolveTicket(service: string): Promise<AccessTicket> {
    const stored = await this.readFromStorage(service);
    if (stored && this.isTicketValid(stored)) {
      this.#ticketCache.set(service, stored);
      safeEmit(this.onEvent, { type: 'auth:cache-hit', service, source: 'storage' });
      return stored;
    }

    // Ticket por vencer (dentro del margen): se intenta renovar, pero si WSAA
    // todavía no lo permite se sigue usando hasta su vencimiento real.
    const expiring = [this.#ticketCache.get(service), stored].find(
      (t): t is AccessTicket => t != null && this.isTicketUsable(t),
    );

    // Login fallido hace poco: WSAA pide no reintentar enseguida.
    const failure = this.loginFailures.get(service);
    if (failure) {
      const remaining = failure.until - Date.now();
      if (remaining > 0) {
        if (expiring) {
          this.#ticketCache.set(service, expiring);
          safeEmit(this.onEvent, { type: 'auth:cache-hit', service, source: 'memory' });
          return expiring;
        }
        const msg = failure.error instanceof Error ? failure.error.message : String(failure.error);
        throw new ArcaAuthError(
          `WSAA login para servicio "${service}" falló recientemente; no se reintenta por ` +
            `${Math.ceil(remaining / 1000)}s más (loginErrorCooldownMs): ${msg}`,
          { cause: failure.error },
        );
      }
      this.loginFailures.delete(service);
    }

    let ticket: AccessTicket;
    try {
      ticket = await this.loginWithClockSkew(service);
    } catch (error) {
      if (isAlreadyAuthenticated(error)) {
        // Otro proceso pudo haber guardado un ticket nuevo mientras nos logueábamos.
        const found = await this.findUsableTicket(service, expiring);
        if (found) {
          const { ticket: usable, source } = found;
          this.#ticketCache.set(service, usable);
          if (!this.isTicketValid(usable)) {
            this.loginBlockedUntil.set(service, Date.now() + this.msToExpiry(usable));
          }
          safeEmit(this.onEvent, { type: 'auth:cache-hit', service, source });
          return usable;
        }
        throw new ArcaTicketVigenteError(service, { cause: error });
      }
      if (this.loginErrorCooldownMs > 0 && startsCooldown(error)) {
        this.loginFailures.set(service, { until: Date.now() + this.loginErrorCooldownMs, error });
      }
      if (error instanceof ArcaAuthError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new ArcaAuthError(`WSAA login falló para servicio "${service}": ${msg}`, { cause: error });
    }

    this.#ticketCache.set(service, ticket);
    this.loginBlockedUntil.delete(service);
    await this.writeToStorage(service, ticket);
    return ticket;
  }

  /**
   * Tras `coe.alreadyAuthenticated`: relee el storage unas pocas veces (otro
   * proceso puede estar por guardar el TA que obtuvo) y, si no aparece, usa el
   * ticket por vencer que ya teníamos.
   */
  private async findUsableTicket(
    service: string,
    expiring: AccessTicket | undefined,
  ): Promise<{ ticket: AccessTicket; source: 'memory' | 'storage' } | undefined> {
    const delays = this.storage ? ALREADY_AUTHENTICATED_REREAD_DELAYS_MS : [];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await delay(delays[i]);
      const again = await this.readFromStorage(service);
      if (again && this.isTicketUsable(again)) return { ticket: again, source: 'storage' };
      // Si ya tenemos un ticket utilizable no hace falta esperar más.
      if (expiring && this.isTicketUsable(expiring)) return { ticket: expiring, source: 'memory' };
    }
    if (expiring && this.isTicketUsable(expiring)) return { ticket: expiring, source: 'memory' };
    return undefined;
  }

  private async loginWithClockSkew(service: string): Promise<AccessTicket> {
    try {
      return await this.performLogin(service);
    } catch (error) {
      if (!this.autoClockSkew || !isClockSkewError(error)) throw error;
      const responseDate = (error as ArcaSoapError).responseDate;
      if (!responseDate) throw error;

      const previousOffsetMs = this.offsetMs;
      this.offsetMs = responseDate.getTime() - Date.now();
      safeEmit(this.onEvent, { type: 'auth:clock-skew', service, offsetMs: this.offsetMs, previousOffsetMs });
      return this.performLogin(service);
    }
  }

  private async performLogin(service: string): Promise<AccessTicket> {
    const start = Date.now();
    const traXml = this.createTRA(service);
    const cms = this.signTRA(traXml);

    const bodyContent =
      `<loginCms xmlns="${WSAA_NAMESPACE}">` +
      `<in0>${cms}</in0>` +
      `</loginCms>`;

    const parsed = await soapCall(this.endpoint, bodyContent, {
      ...this.soapOpts,
      soapAction: '',
      onEvent: this.onEvent,
      methodName: 'loginCms',
    });

    const ticket = this.parseLoginResponse(parsed);
    ticket.service = service;

    safeEmit(this.onEvent, {
      type: 'auth:login',
      service,
      durationMs: Date.now() - start,
    });

    return ticket;
  }

  private async readFromStorage(service: string): Promise<AccessTicket | null> {
    if (!this.storage) return null;
    try {
      const raw = await this.storage.get(this.ticketKey(service), {
        onError: (error) => this.emitStorageError(service, 'get', error),
      });
      return normalizeAccessTicket(raw);
    } catch (error) {
      this.emitStorageError(service, 'get', error);
      return null;
    }
  }

  private async writeToStorage(service: string, ticket: AccessTicket): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.set(this.ticketKey(service), ticket);
    } catch (error) {
      // El ticket sigue siendo válido en memoria; no fallar la operación.
      this.emitStorageError(service, 'set', error);
    }
  }

  private async deleteFromStorage(service: string): Promise<void> {
    if (!this.storage?.delete) return;
    try {
      await this.storage.delete(this.ticketKey(service));
    } catch (error) {
      this.emitStorageError(service, 'delete', error);
    }
  }

  private emitStorageError(service: string, operation: 'get' | 'set' | 'delete', error: unknown): void {
    safeEmit(this.onEvent, {
      type: 'auth:storage-error',
      service,
      operation,
      error: error instanceof Error ? error : String(error),
    });
  }

  private parseLoginResponse(parsed: Record<string, unknown>): AccessTicket {
    // Los Faults (HTTP 500 o 200) se lanzan como ArcaSoapError con faultCode/faultString.
    const response = extractMethodResult(parsed, 'loginCms');
    const loginReturn = response['loginCmsReturn'] ?? response['return'];
    if (typeof loginReturn !== 'string' || !loginReturn) {
      throw new ArcaAuthError('Respuesta WSAA inválida: falta loginCmsReturn');
    }
    return this.parseAccessTicket(loginReturn);
  }

  private parseAccessTicket(xml: string): AccessTicket {
    const parsed = parseXml(xml);
    const loginTicketResponse = parsed['loginTicketResponse'] as Record<string, unknown> | undefined;
    if (!loginTicketResponse) {
      throw new ArcaAuthError('Access ticket inválido: falta loginTicketResponse');
    }

    const credentials = loginTicketResponse['credentials'] as Record<string, unknown> | undefined;
    if (!credentials) {
      throw new ArcaAuthError('Access ticket inválido: falta credentials');
    }

    const header = loginTicketResponse['header'] as Record<string, unknown> | undefined;

    const token = credentials['token'] as string;
    const sign = credentials['sign'] as string;

    if (!token || !sign) {
      throw new ArcaAuthError('Access ticket inválido: falta token o sign');
    }

    const ticket = normalizeAccessTicket({
      token,
      sign,
      expirationTime: header?.['expirationTime']
        ?? new Date(this.now().getTime() + this.tokenTTLMinutes * 60_000),
      generationTime: header?.['generationTime'],
    });
    if (!ticket) {
      throw new ArcaAuthError('Access ticket inválido: expirationTime ilegible');
    }
    return ticket;
  }

  /**
   * Crea el Ticket de Requerimiento de Acceso (TRA) XML.
   */
  private createTRA(service: string): string {
    const now = this.now();
    // `uniqueId` es xsd:unsignedInt (32 bits) en la spec de WSAA: un valor al
    // azar evita colisiones entre TRAs generados en el mismo segundo.
    const uniqueId = randomInt(1, 0x1_0000_0000);
    const generationTime = new Date(now.getTime() - TRA_GENERATION_OFFSET_MS).toISOString();
    const expirationTime = new Date(
      now.getTime() + this.tokenTTLMinutes * 60_000,
    ).toISOString();

    const tra = {
      loginTicketRequest: {
        '@_version': '1.0',
        header: {
          uniqueId,
          generationTime,
          expirationTime,
        },
        service,
      },
    };

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + buildXml(tra);
  }

  /**
   * Firma el TRA con CMS/PKCS#7 usando el certificado y la clave privada.
   */
  private signTRA(traXml: string): string {
    const certificate = forge.pki.certificateFromPem(this.#cert);
    const privateKey = forge.pki.privateKeyFromPem(this.#key);

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(traXml, 'utf8');
    p7.addCertificate(certificate);
    p7.addSigner({
      key: privateKey,
      certificate,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        {
          type: forge.pki.oids.contentType,
          value: forge.pki.oids.data,
        },
        {
          type: forge.pki.oids.messageDigest,
        },
        {
          type: forge.pki.oids.signingTime,
          value: this.now() as any,
        },
      ],
    });
    p7.sign();

    const asn1 = p7.toAsn1();
    const der = forge.asn1.toDer(asn1);
    return forge.util.encode64(der.getBytes());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function environmentLabel(endpoint: string): string {
  if (endpoint === WSAA_ENDPOINTS.production) return 'prod';
  if (endpoint === WSAA_ENDPOINTS.testing) return 'homo';
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 8);
}

/** Huella corta del certificado: identifica al emisor sin exponer el PEM. */
function certFingerprint(pem: string): string {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function faultText(error: unknown): string {
  if (!(error instanceof ArcaSoapError)) return '';
  return `${error.faultCode ?? ''} ${error.faultString ?? ''}`;
}

/** WSAA: "coe.alreadyAuthenticated: El CEE ya posee un TA valido para el acceso al WSN solicitado". */
function isAlreadyAuthenticated(error: unknown): boolean {
  return /alreadyAuthenticated|ya posee un TA/i.test(faultText(error));
}

/**
 * Errores de WSAA (spec 1.2.2) que indican un reloj local desfasado:
 * - `xml.generationTime.invalid`: generationTime posterior a la hora de WSAA o
 *   demasiado antiguo.
 * - `xml.expirationTime.expired`: expirationTime anterior a la hora de WSAA.
 *
 * No incluye `xml.expirationTime.invalid` (vigencia pedida mayor a 24 horas):
 * es un error de configuración (`tokenTTLMinutes`), no del reloj.
 */
function isClockSkewError(error: unknown): boolean {
  if (!(error instanceof ArcaSoapError)) return false;
  const code = error.faultCode ?? '';
  if (/generationTime\.invalid|expirationTime\.expired/i.test(code)) return true;
  if (/expirationTime\.invalid/i.test(code)) return false;
  // Sin código reconocible: se mira el texto del Fault.
  const text = error.faultString ?? '';
  return /generationTime/i.test(text) || /expirationTime posee una fecha anterior/i.test(text);
}

/**
 * Un login fallido inicia la espera de `loginErrorCooldownMs`, salvo que el
 * error no tenga que ver con el TRA enviado: TA vigente, desfase de reloj (se
 * corrige solo), abort del caller, o error de red con certeza de que el
 * request no se envió.
 */
function startsCooldown(error: unknown): boolean {
  if (isAlreadyAuthenticated(error) || isClockSkewError(error)) return false;
  if (error instanceof ArcaSoapError) {
    if (error.aborted) return false;
    const notSent = !error.uncertain && error.statusCode === undefined && error.faultString === undefined;
    if (notSent) return false;
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  toError: (reason: unknown) => Error,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(toError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(toError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
