import forge from 'node-forge';
import { ArcaAuthError } from './errors.js';
import { soapCall, parseXml, buildXml, getNestedValue } from './soap-client.js';
import type { AccessTicket, ArcaEvent, SoapCallOptions } from './types.js';
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
}

/**
 * Cliente para el WSAA (Web Service de Autenticación y Autorización) de ARCA.
 * Maneja la creación del TRA, firma CMS/PKCS#7, login, y cache de tokens.
 */
export class WsaaClient {
  private readonly cert: string;
  private readonly key: string;
  private readonly endpoint: string;
  private readonly tokenTTLMinutes: number;
  private readonly soapOpts: Pick<SoapCallOptions, 'timeout' | 'retries' | 'retryDelayMs'>;
  private readonly onEvent?: (event: ArcaEvent) => void;

  private readonly ticketCache = new Map<string, AccessTicket>();
  private readonly pendingLogins = new Map<string, Promise<AccessTicket>>();

  constructor(config: WsaaClientConfig) {
    this.cert = config.cert;
    this.key = config.key;
    this.endpoint = config.endpoint
      ?? (config.production ? WSAA_ENDPOINTS.production : WSAA_ENDPOINTS.testing);
    this.tokenTTLMinutes = config.tokenTTLMinutes ?? 720;
    this.onEvent = config.onEvent;
    this.soapOpts = {
      timeout: config.timeout,
      retries: config.retries,
      retryDelayMs: config.retryDelayMs,
    };
  }

  /**
   * Obtiene un Ticket de Acceso (TA) para el servicio indicado.
   * Reutiliza el ticket cacheado si no expiró.
   * Deduplica requests concurrentes de login para el mismo servicio.
   */
  async getAccessTicket(service: string): Promise<AccessTicket> {
    const cached = this.ticketCache.get(service);
    if (cached && this.isTicketValid(cached)) {
      this.onEvent?.({ type: 'auth:cache-hit', service });
      return cached;
    }

    // Dedup: si ya hay un login en curso para este servicio, reusar la promesa
    const pending = this.pendingLogins.get(service);
    if (pending) return pending;

    const loginPromise = this.performLogin(service)
      .then((ticket) => {
        this.ticketCache.set(service, ticket);
        this.pendingLogins.delete(service);
        return ticket;
      })
      .catch((err) => {
        this.pendingLogins.delete(service);
        throw err;
      });

    this.pendingLogins.set(service, loginPromise);
    return loginPromise;
  }

  /**
   * Invalida el ticket cacheado para un servicio.
   */
  clearTicket(service: string): void {
    this.ticketCache.delete(service);
  }

  /**
   * Invalida todos los tickets cacheados.
   */
  clearAllTickets(): void {
    this.ticketCache.clear();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private isTicketValid(ticket: AccessTicket): boolean {
    return ticket.expirationTime.getTime() - Date.now() > EXPIRY_MARGIN_MS;
  }

  private async performLogin(service: string): Promise<AccessTicket> {
    const start = Date.now();

    try {
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

      this.onEvent?.({
        type: 'auth:login',
        service,
        durationMs: Date.now() - start,
      });

      return ticket;
    } catch (error) {
      if (error instanceof ArcaAuthError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new ArcaAuthError(`WSAA login falló para servicio "${service}": ${msg}`);
    }
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
      const faultString = (fault['faultstring'] ?? fault['faultString'] ?? 'Fault WSAA desconocido') as string;
      throw new ArcaAuthError(`WSAA Fault: ${faultString}`);
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

    let expirationTime: Date;
    const headerExp = header?.['expirationTime'] as string | undefined;
    if (headerExp) {
      expirationTime = new Date(headerExp);
    } else {
      expirationTime = new Date(Date.now() + this.tokenTTLMinutes * 60_000);
    }

    return { token, sign, expirationTime };
  }

  /**
   * Crea el Ticket de Requerimiento de Acceso (TRA) XML.
   */
  private createTRA(service: string): string {
    const now = new Date();
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
          value: new Date() as any,
        },
      ],
    });
    p7.sign();

    const asn1 = p7.toAsn1();
    const der = forge.asn1.toDer(asn1);
    return forge.util.encode64(der.getBytes());
  }
}
