import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { afipSoapCall, soapCall } from '../src/soap-client.js';
import { ArcaSoapError } from '../src/errors.js';
import { mockFetch, soapEnvelope, soapFault, xmlResponse } from './helpers.js';

const URL = 'https://example.test/ws';
const OK = soapEnvelope('<ns2:dummyResponse xmlns:ns2="http://x/"><return><appserver>OK</appserver></return></ns2:dummyResponse>');

function networkError(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('soapCall: consultas', () => {
  it('reintenta errores de red y devuelve la respuesta', async () => {
    const fetch = mockFetch(networkError('ECONNRESET'), xmlResponse(OK));
    const parsed = await soapCall(URL, '<x/>', { retries: 1, retryDelayMs: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(parsed).toHaveProperty('Envelope');
  });

  it('reintenta un 503 sin SOAP Fault', async () => {
    const fetch = mockFetch(xmlResponse('Service Unavailable', 503), xmlResponse(OK));
    await soapCall(URL, '<x/>', { retries: 1, retryDelayMs: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('no reintenta un SOAP Fault y expone faultCode/faultString/responseDate', async () => {
    const fetch = mockFetch(
      xmlResponse(soapFault('ns1:coe.alreadyAuthenticated', 'El CEE ya posee un TA valido'), 500, {
        date: 'Thu, 29 Oct 2026 15:00:00 GMT',
      }),
    );
    const err = await soapCall(URL, '<x/>', { retries: 3, retryDelayMs: 1 }).catch((e) => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ArcaSoapError);
    expect(err.statusCode).toBe(500);
    expect(err.faultCode).toBe('ns1:coe.alreadyAuthenticated');
    expect(err.faultString).toBe('El CEE ya posee un TA valido');
    expect(err.responseDate?.toISOString()).toBe('2026-10-29T15:00:00.000Z');
  });

  it('no reintenta un 4xx y lo marca como no incierto', async () => {
    const fetch = mockFetch(xmlResponse('Bad request', 400));
    const err = await soapCall(URL, '<x/>', { retries: 3, retryDelayMs: 1 }).catch((e) => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err.uncertain).toBe(false);
  });
});

describe('soapCall: emisiones', () => {
  it('nunca reintenta, aunque haya retries configurados', async () => {
    const fetch = mockFetch(networkError('ECONNRESET'), xmlResponse(OK));
    const err = await soapCall(URL, '<x/>', { kind: 'emision', retries: 5, retryDelayMs: 1 }).catch((e) => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ArcaSoapError);
    expect(err.uncertain).toBe(true);
  });

  it('un timeout es incierto', async () => {
    mockFetch(
      () =>
        new Promise<Response>((_, reject) => {
          // fetch real rechaza cuando se aborta el signal
          setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 50);
        }),
    );
    const err = await soapCall(URL, '<x/>', { kind: 'emision', timeout: 10 }).catch((e) => e);
    expect(err.uncertain).toBe(true);
    expect(err.message).toMatch(/Timeout/);
  });

  it('un 5xx es incierto', async () => {
    mockFetch(xmlResponse('Internal error', 500));
    const err = await soapCall(URL, '<x/>', { kind: 'emision' }).catch((e) => e);
    expect(err.uncertain).toBe(true);
  });

  it('falla de DNS o conexión rechazada: hay certeza de que no se envió', async () => {
    mockFetch(networkError('ENOTFOUND'));
    const dns = await soapCall(URL, '<x/>', { kind: 'emision' }).catch((e) => e);
    expect(dns.uncertain).toBe(false);

    mockFetch(networkError('ECONNREFUSED'));
    const refused = await soapCall(URL, '<x/>', { kind: 'emision' }).catch((e) => e);
    expect(refused.uncertain).toBe(false);
  });

  it('signal abortado antes de enviar: no se envía y no es incierto', async () => {
    const fetch = mockFetch(xmlResponse(OK));
    const controller = new AbortController();
    controller.abort();
    const err = await soapCall(URL, '<x/>', { kind: 'emision', signal: controller.signal }).catch((e) => e);
    expect(fetch).not.toHaveBeenCalled();
    expect(err.aborted).toBe(true);
    expect(err.uncertain).toBe(false);
  });

  it('signal abortado durante el request: incierto', async () => {
    const controller = new AbortController();
    mockFetch(
      () =>
        new Promise<Response>((_, reject) => {
          setTimeout(() => {
            controller.abort();
            reject(new DOMException('aborted', 'AbortError'));
          }, 5);
        }),
    );
    const err = await soapCall(URL, '<x/>', { kind: 'emision', signal: controller.signal }).catch((e) => e);
    expect(err.aborted).toBe(true);
    expect(err.uncertain).toBe(true);
  });
});

describe('afipSoapCall', () => {
  it('envía los parámetros sin namespace (método prefijado)', async () => {
    const fetch = mockFetch(xmlResponse(OK));
    await afipSoapCall(URL, 'http://a13.soap.ws.server.puc.sr/', 'dummy', { token: 't', sign: 's' });
    const body = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(body).toContain('<ser:dummy xmlns:ser="http://a13.soap.ws.server.puc.sr/">');
    expect(body).toMatch(/<token>t<\/token>\s*<sign>s<\/sign>/);
  });

  it('acepta el tag de respuesta con prefijo y desenvuelve *Return', async () => {
    mockFetch(
      xmlResponse(
        soapEnvelope(
          '<ns2:getPersonaResponse xmlns:ns2="http://a13.soap.ws.server.puc.sr/">' +
            '<personaReturn><metadata><servidor>x</servidor></metadata><persona><idPersona>20123456789</idPersona></persona></personaReturn>' +
            '</ns2:getPersonaResponse>',
        ),
      ),
    );
    const result = await afipSoapCall(URL, 'http://a13.soap.ws.server.puc.sr/', 'getPersona', {});
    expect(result).toHaveProperty('persona');
    expect((result['persona'] as Record<string, unknown>)['idPersona']).toBe('20123456789');
  });

  it('SOAP Fault con HTTP 200 se lanza como ArcaSoapError', async () => {
    mockFetch(xmlResponse(soapFault('soap:Server', 'Error interno')));
    await expect(afipSoapCall(URL, 'http://x/', 'dummy', {})).rejects.toMatchObject({
      faultString: 'Error interno',
    });
  });
});

describe('anySignal', async () => {
  const { anySignal } = await import('../src/signals.js');

  it('devuelve el único signal presente', () => {
    const c = new AbortController();
    expect(anySignal(undefined, c.signal)).toBe(c.signal);
    expect(anySignal(undefined, undefined)).toBeUndefined();
  });

  it('se aborta cuando se aborta cualquiera, con su reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = anySignal(a.signal, b.signal)!;
    expect(combined.aborted).toBe(false);
    b.abort('chau');
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('chau');
  });
});
