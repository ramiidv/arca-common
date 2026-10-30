import { createHash } from 'node:crypto';
import forge from 'node-forge';
import { ArcaAuthError, ArcaSoapError, ArcaTicketVigenteError } from './errors.js';
import { soapCall, parseXml, buildXml, getNestedValue } from './soap-client.js';
import { normalizeAccessTicket } from './ticket-storage.js';
import type { AccessTicket, ArcaEvent, CallOptions, SoapCallOptions, TicketStorage } from './types.js';
import { WSAA_ENDPOINTS, WSAA_NAMESPACE } from './constants.js';

/** Margen de seguridad antes de considerar un token expirado (2 minutos). */
const EXPIRY_MARGIN_MS = 2 * 60_000;

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
}

/**
 * Cliente para el WSAA (Web Service de Autenticación y Autorización) de ARCA.
 * Maneja la creación del TRA, firma CMS/PKCS#7, login, y cache de tokens.
 *
 * Orden de búsqueda de un ticket: memoria → `ticketStorage` → login.
 * Los logins concurrentes para el mismo servicio se deduplican.
 */
export class WsaaClient {
  private readonly cert: string;
  private readonly key: string;
  private readonly endpoint: string;
  private readonly tokenTTLMinutes: number;
  private readonly soapOpts: Pick<SoapCallOptions, 'timeout' | 'retries' | 'retryDelayMs'>;
  private readonly onEvent?: (event: ArcaEvent) => void;
  private readonly storage?: TicketStorage;
  private readonly autoClockSkew: boolean;
  private readonly keyPrefix: string;
  private offsetMs: number;

  private readonly ticketCache = new Map<string, AccessTicket>();
  private readonly pendingLogins = new Map<string, Promise<AccessTicket>>();

  constructor(config: WsaaClientConfig) {
    this.cert = config.cert;
    this.key = config.key;
    this.endpoint = config.endpoint
      ?? (config.production ? WSAA_ENDPOINTS.production : WSAA_ENDPOINTS.testing);
    this.tokenTTLMinutes = config.tokenTTLMinutes ?? 720;
    this.onEvent = config.onEvent;
    this.storage = config.ticketStorage;
    this.autoClockSkew = config.autoClockSkew ?? true;
    this.offsetMs = config.clockOffsetMs ?? 0;
    this.soapOpts = {
      timeout: config.timeout,
      retries: config.retries,
      retryDelayMs: config.retryDelayMs,
    };
    this.keyPrefix = `${environmentLabel(this.endpoint)}:${certFingerprint(this.cert)}`;
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
    const cached = this.ticketCache.get(service);
    if (cached && this.isTicketValid(cached)) {
      this.onEvent?.({ type: 'auth:cache-hit', service, source: 'memory' });
      return cached;
    }

    let pending = this.pendingLogins.get(service);
    if (!pending) {
      pending = this.resolveTicket(service).finally(() => {
        this.pendingLogins.delete(service);
      });
      this.pendingLogins.set(service, pending);
    }
    return raceWithSignal(pending, opts?.signal);
  }

  /**
   * Invalida el ticket de un servicio, en memoria y en el `ticketStorage`.
   */
  async clearTicket(service: string): Promise<void> {
    this.ticketCache.delete(service);
    await this.deleteFromStorage(service);
  }

  /**
   * Invalida todos los tickets que este cliente conoce (los que pasaron por
   * memoria en este proceso), también en el `ticketStorage`.
   */
  async clearAllTickets(): Promise<void> {
    const services = [...this.ticketCache.keys()];
    this.ticketCache.clear();
    await Promise.all(services.map((s) => this.deleteFromStorage(s)));
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private isTicketValid(ticket: AccessTicket): boolean {
    const expires = Date.parse(ticket.expirationTime);
    return Number.isFinite(expires) && expires - this.now().getTime() > EXPIRY_MARGIN_MS;
  }

  private async resolveTicket(service: string): Promise<AccessTicket> {
    const stored = await this.readFromStorage(service);
    if (stored && this.isTicketValid(stored)) {
      this.ticketCache.set(service, stored);
      this.onEvent?.({ type: 'auth:cache-hit', service, source: 'storage' });
      return stored;
    }

    let ticket: AccessTicket;
    try {
      ticket = await this.loginWithClockSkew(service);
    } catch (error) {
      if (isAlreadyAuthenticated(error)) {
        // Otro proceso pudo haber guardado el ticket mientras nos logueábamos.
        const again = await this.readFromStorage(service);
        if (again && this.isTicketValid(again)) {
          this.ticketCache.set(service, again);
          this.onEvent?.({ type: 'auth:cache-hit', service, source: 'storage' });
          return again;
        }
        throw new ArcaTicketVigenteError(service, { cause: error });
      }
      if (error instanceof ArcaAuthError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new ArcaAuthError(`WSAA login falló para servicio "${service}": ${msg}`, { cause: error });
    }

    this.ticketCache.set(service, ticket);
    await this.writeToStorage(service, ticket);
    return ticket;
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
      this.onEvent?.({ type: 'auth:clock-skew', service, offsetMs: this.offsetMs, previousOffsetMs });
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

    this.onEvent?.({
      type: 'auth:login',
      service,
      durationMs: Date.now() - start,
    });

    return ticket;
  }

  private async readFromStorage(service: string): Promise<AccessTicket | null> {
    if (!this.storage) return null;
    try {
      return normalizeAccessTicket(await this.storage.get(this.ticketKey(service)));
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
    this.onEvent?.({
      type: 'auth:storage-error',
      service,
      operation,
      error: error instanceof Error ? error : String(error),
    });
  }

  private parseLoginResponse(parsed: Record<string, unknown>): AccessTicket {
    const envelope = getNestedValue(
      parsed,
      'soapenv:Envelope', 'soap:Envelope', 'Envelope', 'S:Envelope',
    ) as Record<string, unknown> | undefined;
    if (!envelope) {
      throw new ArcaAuthError('Respuesta WSAA inválida: falta Envelope');
    }

    const body = getNestedValue(
      envelope,
      'soapenv:Body', 'soap:Body', 'Body', 'S:Body',
    ) as Record<string, unknown> | undefined;
    if (!body) {
      throw new ArcaAuthError('Respuesta WSAA inválida: falta Body');
    }

    // Verificar fault
    const fault = getNestedValue(
      body,
      'soapenv:Fault', 'soap:Fault', 'Fault', 'S:Fault',
    ) as Record<string, unknown> | undefined;
    if (fault) {
      const faultString = String(fault['faultstring'] ?? fault['faultString'] ?? 'Fault WSAA desconocido');
      const faultCode = fault['faultcode'] !== undefined ? String(fault['faultcode']) : undefined;
      throw new ArcaSoapError(`WSAA Fault: ${faultString}`, { faultCode, faultString });
    }

    const loginResponse = getNestedValue(
      body,
      'loginCmsResponse', 'ns2:loginCmsResponse',
    ) as Record<string, unknown> | undefined;
    if (!loginResponse) {
      throw new ArcaAuthError('Respuesta WSAA inválida: falta loginCmsResponse');
    }

    const loginReturn = getNestedValue(
      loginResponse,
      'loginCmsReturn', 'ns2:loginCmsReturn', 'return',
    ) as string | undefined;
    if (!loginReturn) {
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
    const uniqueId = Math.floor(now.getTime() / 1000);
    const generationTime = new Date(now.getTime() - 120_000).toISOString();
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
    const certificate = forge.pki.certificateFromPem(this.cert);
    const privateKey = forge.pki.privateKeyFromPem(this.key);

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

/** WSAA: "xml.generationTime.invalid" / "xml.expirationTime.invalid" y variantes. */
function isClockSkewError(error: unknown): boolean {
  return /generationTime|expirationTime/i.test(faultText(error));
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
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
