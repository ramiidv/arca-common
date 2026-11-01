import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, soapEnvelope, xmlResponse } from './helpers.js';

vi.mock('../src/legacy-tls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/legacy-tls.js')>();
  return { ...actual, legacyTlsRequest: vi.fn() };
});

const { legacyTlsRequest } = await import('../src/legacy-tls.js');
const { soapCall, resetLegacyTlsHosts } = await import('../src/soap-client.js');
const { ArcaSoapError } = await import('../src/errors.js');

const legacy = vi.mocked(legacyTlsRequest);
const URL = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx';
const OK = soapEnvelope('<FEDummyResponse><FEDummyResult><AppServer>OK</AppServer></FEDummyResult></FEDummyResponse>');

function dhTooSmall(): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('dh key too small'), { code: 'ERR_SSL_DH_KEY_TOO_SMALL' }),
  });
}

function legacyOk(body = OK) {
  return { status: 200, statusText: 'OK', headers: { date: 'Thu, 29 Oct 2026 15:00:00 GMT' }, body };
}

beforeEach(() => {
  resetLegacyTlsHosts();
  legacy.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('soapCall: fallback TLS legacy', () => {
  it('ante ERR_SSL_DH_KEY_TOO_SMALL reintenta con el transporte legacy (también en emisiones)', async () => {
    const fetch = mockFetch(dhTooSmall());
    legacy.mockResolvedValueOnce(legacyOk());

    const parsed = await soapCall(URL, '<x/>', { kind: 'emision', timeout: 5_000 });
    expect(parsed).toHaveProperty('Envelope');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(legacy).toHaveBeenCalledTimes(1);

    const [url, init] = legacy.mock.calls[0];
    expect(url).toBe(URL);
    expect(init.method).toBe('POST');
    expect(init.body).toContain('<x/>');
    expect(init.headers['SOAPAction']).toBe('""');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('recuerda el host: la siguiente llamada va directo por legacy', async () => {
    mockFetch(dhTooSmall());
    legacy.mockResolvedValue(legacyOk());
    await soapCall(URL, '<x/>');

    const fetch = mockFetch();
    await soapCall(URL, '<y/>');
    expect(fetch).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it('expone status, Fault y responseDate de la respuesta legacy', async () => {
    mockFetch(dhTooSmall());
    legacy.mockResolvedValueOnce({
      status: 500,
      statusText: 'Internal Server Error',
      headers: { date: 'Thu, 29 Oct 2026 15:00:00 GMT' },
      body: soapEnvelope('<soap:Fault xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>soap:Server</faultcode><faultstring>boom</faultstring></soap:Fault>'),
    });
    const err = await soapCall(URL, '<x/>').catch((e) => e);
    expect(err).toBeInstanceOf(ArcaSoapError);
    expect(err).toMatchObject({ statusCode: 500, faultString: 'boom', uncertain: false });
    expect(err.responseDate?.toISOString()).toBe('2026-10-29T15:00:00.000Z');
  });

  it('legacyTls: never no usa el fallback (error de red no incierto)', async () => {
    mockFetch(dhTooSmall());
    const err = await soapCall(URL, '<x/>', { kind: 'emision', legacyTls: 'never' }).catch((e) => e);
    expect(legacy).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(ArcaSoapError);
    expect(err.uncertain).toBe(false);
    expect(err.message).toContain('ERR_SSL_DH_KEY_TOO_SMALL');
  });

  it('legacyTls: always usa siempre el transporte legacy', async () => {
    const fetch = mockFetch();
    legacy.mockResolvedValueOnce(legacyOk());
    await soapCall('https://otro.afip.gov.ar/ws', '<x/>', { legacyTls: 'always' });
    expect(fetch).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('con un fetch inyectado no hay fallback', async () => {
    const own = vi.fn(async () => {
      throw dhTooSmall();
    });
    const err = await soapCall(URL, '<x/>', { fetch: own as unknown as typeof fetch, retries: 0 }).catch((e) => e);
    expect(own).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(ArcaSoapError);
  });

  it('respeta el timeout en el transporte legacy', async () => {
    mockFetch(dhTooSmall());
    legacy.mockImplementationOnce(
      (_url, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const err = await soapCall(URL, '<x/>', { kind: 'emision', timeout: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(ArcaSoapError);
    expect(err.message).toMatch(/Timeout/);
    expect(err.uncertain).toBe(true);
  });

  it('otros errores de red no usan el transporte legacy', async () => {
    mockFetch(
      new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
      xmlResponse(OK),
    );
    await soapCall(URL, '<x/>', { retries: 1, retryDelayMs: 1 });
    expect(legacy).not.toHaveBeenCalled();
  });
});
