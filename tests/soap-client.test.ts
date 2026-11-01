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

describe('soapCall: regresiones', () => {
  it('un onEvent que lanza no convierte una respuesta exitosa en error', async () => {
    mockFetch(xmlResponse(OK));
    const parsed = await soapCall(URL, '<x/>', {
      kind: 'emision',
      onEvent: () => {
        throw new Error('logger roto');
      },
    });
    expect(parsed).toHaveProperty('Envelope');
  });

  it('una respuesta 200 cortada a mitad del body se reintenta en consultas', async () => {
    const cortada = new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error('conexión cortada'));
        },
      }),
      { status: 200 },
    );
    const fetch = mockFetch(cortada, xmlResponse(OK));
    await soapCall(URL, '<x/>', { retries: 1, retryDelayMs: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 0.4.0
// ---------------------------------------------------------------------------

import {
  checkServiceErrors,
  extractMethodResult,
  extractServiceErrors,
  getNestedValue,
  parseXml,
} from '../src/soap-client.js';
import { ArcaServiceError } from '../src/errors.js';

function sentBody(fetch: ReturnType<typeof mockFetch>, call = 0): string {
  return (fetch.mock.calls[call] as unknown as [string, RequestInit])[1].body as string;
}
function sentHeaders(fetch: ReturnType<typeof mockFetch>, call = 0): Record<string, string> {
  return (fetch.mock.calls[call] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
}

describe('soapCall: SOAP Faults y respuestas no SOAP', () => {
  it('un Fault con HTTP 200 se lanza igual que con 500', async () => {
    const fetch = mockFetch(
      xmlResponse(soapFault('soap:Server', 'Error interno'), 200, { date: 'Thu, 29 Oct 2026 15:00:00 GMT' }),
    );
    const err = await soapCall(URL, '<x/>', { retries: 2, retryDelayMs: 1 }).catch((e) => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ArcaSoapError);
    expect(err).toMatchObject({ statusCode: 200, faultCode: 'soap:Server', faultString: 'Error interno' });
    expect(err.responseDate?.toISOString()).toBe('2026-10-29T15:00:00.000Z');
  });

  it('un Fault en consulta no es incierto; en emisión sí', async () => {
    mockFetch(xmlResponse(soapFault('soap:Server', 'x'), 500));
    expect((await soapCall(URL, '<x/>').catch((e) => e)).uncertain).toBe(false);
    mockFetch(xmlResponse(soapFault('soap:Server', 'x'), 500));
    expect((await soapCall(URL, '<x/>', { kind: 'emision' }).catch((e) => e)).uncertain).toBe(true);
  });

  it('un 200 con HTML (no SOAP) se reintenta en consultas', async () => {
    const html = '<html><body><h1>Sitio en mantenimiento</h1></body></html>';
    const fetch = mockFetch(xmlResponse(html), xmlResponse(OK));
    const parsed = await soapCall(URL, '<x/>', { retries: 1, retryDelayMs: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(parsed).toHaveProperty('Envelope');
  });

  it('un 200 no SOAP en emisión es incierto', async () => {
    mockFetch(xmlResponse('Service temporarily unavailable'));
    const err = await soapCall(URL, '<x/>', { kind: 'emision' }).catch((e) => e);
    expect(err).toBeInstanceOf(ArcaSoapError);
    expect(err.uncertain).toBe(true);
    expect(err.faultString).toBeUndefined();
  });

  it('usa el fetch inyectado en lugar del global', async () => {
    const global = mockFetch();
    const own = vi.fn(async () => xmlResponse(OK));
    await soapCall(URL, '<x/>', { fetch: own as unknown as typeof fetch });
    expect(own).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });
});

describe('afipSoapCall: opciones', () => {
  const NS = 'http://ar.gov.afip.dif.FEV1/';

  it('qualified: el wrapper declara el namespace por defecto', async () => {
    const fetch = mockFetch(
      xmlResponse(soapEnvelope(`<FEDummyResponse xmlns="${NS}"><FEDummyResult><AppServer>OK</AppServer></FEDummyResult></FEDummyResponse>`)),
    );
    const result = await afipSoapCall(URL, NS, 'FEDummy', { Auth: { Token: 't' } }, { qualified: true });
    expect(sentBody(fetch)).toContain(`<FEDummy xmlns="${NS}">`);
    expect(sentBody(fetch)).toMatch(/<Auth>\s*<Token>t<\/Token>\s*<\/Auth>/);
    expect(result).toEqual({ AppServer: 'OK' });
  });

  it('soapActionFromMethod arma la SOAPAction con o sin barra', async () => {
    let fetch = mockFetch(xmlResponse(soapEnvelope('<FEDummyResponse><FEDummyResult/></FEDummyResponse>')));
    await afipSoapCall(URL, NS, 'FEDummy', {}, { soapActionFromMethod: true });
    expect(sentHeaders(fetch).SOAPAction).toBe(`"${NS}FEDummy"`);

    fetch = mockFetch(xmlResponse(soapEnvelope('<dummyResponse/>')));
    await afipSoapCall(URL, 'http://impl.service.wsmtxca.afip.gov.ar/service', 'dummy', {}, { soapActionFromMethod: true });
    expect(sentHeaders(fetch).SOAPAction).toBe('"http://impl.service.wsmtxca.afip.gov.ar/service/dummy"');

    fetch = mockFetch(xmlResponse(soapEnvelope('<dummyResponse/>')));
    await afipSoapCall(URL, NS, 'dummy', {});
    expect(sentHeaders(fetch).SOAPAction).toBe('""');

    fetch = mockFetch(xmlResponse(soapEnvelope('<dummyResponse/>')));
    await afipSoapCall(URL, NS, 'dummy', {}, { soapAction: 'explicita', soapActionFromMethod: true });
    expect(sentHeaders(fetch).SOAPAction).toBe('"explicita"');
  });

  it('requestElement: null envía el Body vacío; requestElement/responseElement personalizados', async () => {
    let fetch = mockFetch(xmlResponse(soapEnvelope('<ns2:dummyResponse xmlns:ns2="x"><return><appserver>OK</appserver></return></ns2:dummyResponse>')));
    const r1 = await afipSoapCall(URL, NS, 'dummy', {}, { requestElement: null });
    expect(sentBody(fetch)).toContain('<soapenv:Body></soapenv:Body>');
    expect(r1).toEqual({ appserver: 'OK' });

    fetch = mockFetch(
      xmlResponse(soapEnvelope('<ns2:consultarResp xmlns:ns2="x"><consultarReturn><a>1</a></consultarReturn></ns2:consultarResp>')),
    );
    const r2 = await afipSoapCall(URL, NS, 'consultar', { p: 1 }, {
      requestElement: 'consultarReq',
      responseElement: 'consultarResp',
    });
    expect(sentBody(fetch)).toContain(`<ser:consultarReq xmlns:ser="${NS}">`);
    expect(r2).toEqual({ a: 1 });
  });

  it('un Fault de afipSoapCall en consulta no es incierto', async () => {
    mockFetch(xmlResponse(soapFault('soap:Server', 'x')));
    const err = await afipSoapCall(URL, NS, 'dummy', {}).catch((e) => e);
    expect(err).toMatchObject({ faultString: 'x', uncertain: false });
  });
});

describe('extractMethodResult', () => {
  it('detecta Faults con prefijos (salida de parseXml)', () => {
    const parsed = parseXml(soapFault('soap:Client', 'Mal request'));
    expect(() => extractMethodResult(parsed, 'dummy')).toThrow(ArcaSoapError);
    try {
      extractMethodResult(parsed, 'dummy');
    } catch (e) {
      expect(e).toMatchObject({ faultCode: 'soap:Client', faultString: 'Mal request', uncertain: false });
    }
    try {
      extractMethodResult(parsed, 'dummy', { kind: 'emision' });
    } catch (e) {
      expect(e).toMatchObject({ uncertain: true });
    }
  });

  it('devuelve la misma forma con o sin prefijos', () => {
    const xml = soapEnvelope('<ns2:getPersonaResponse xmlns:ns2="x"><ns2:return><a>1</a></ns2:return></ns2:getPersonaResponse>');
    expect(extractMethodResult(parseXml(xml), 'getPersona')).toEqual({ a: 1 });
    expect(extractMethodResult(parseXml(soapEnvelope('<dummyResponse/>')), 'dummy')).toEqual({});
  });
});

describe('getNestedValue', () => {
  it('usa solo propiedades propias', () => {
    expect(getNestedValue({}, 'toString')).toBeUndefined();
    expect(getNestedValue({ constructor: 1 }, 'constructor')).toBe(1);
  });

  it('no falla con valores que no son objetos', () => {
    expect(getNestedValue(undefined as never, 'a')).toBeUndefined();
    expect(getNestedValue(null as never, 'a')).toBeUndefined();
    expect(getNestedValue('texto' as never, 'length')).toBeUndefined();
  });

  it('si una key vale undefined/null prueba las siguientes', () => {
    expect(getNestedValue({ a: undefined, b: null, c: 3 }, 'a', 'b', 'c')).toBe(3);
    expect(getNestedValue({ a: null }, 'a', 'b')).toBeNull();
    expect(getNestedValue({ a: 0 }, 'a', 'b')).toBe(0);
  });
});

describe('checkServiceErrors / extractServiceErrors', () => {
  it('WSFE: Errors.Err[]', () => {
    const result = { Errors: { Err: [{ Code: 600, Msg: 'ValidacionDeToken' }, { Code: 601, Msg: 'CUIT' }] } };
    expect(extractServiceErrors(result)).toEqual([
      { code: 600, msg: 'ValidacionDeToken' },
      { code: 601, msg: 'CUIT' },
    ]);
    expect(() => checkServiceErrors(result, 'WSFE')).toThrow(/\[600\] ValidacionDeToken, \[601\] CUIT/);
  });

  it('lanza si cualquier error (no solo el primero) tiene código distinto de 0', () => {
    const result = { Errors: { Err: [{ Code: 0, Msg: 'ok' }, { Code: 10, Msg: 'mal' }] } };
    expect(() => checkServiceErrors(result, 'X')).toThrow(ArcaServiceError);
    expect(() => checkServiceErrors({ Errors: { Err: { Code: 0, Msg: 'ok' } } }, 'X')).not.toThrow();
  });

  it('errors.error[] y errors.err[]', () => {
    expect(extractServiceErrors({ errors: { error: [{ code: 1, msg: 'a' }] } })).toEqual([{ code: 1, msg: 'a' }]);
    expect(extractServiceErrors({ errors: { err: { code: 2, msg: 'b' } } })).toEqual([{ code: 2, msg: 'b' }]);
  });

  it('servicios Java: arrayErrores y arrayErroresFormato', () => {
    const result = {
      arrayErrores: { codigoDescripcion: [{ codigo: 101, descripcion: 'uno' }, { codigo: 102, descripcion: 'dos' }] },
      arrayErroresFormato: { codigoDescripcion: { codigo: 5, descripcion: 'formato' } },
    };
    expect(extractServiceErrors(result)).toEqual([
      { code: 101, msg: 'uno' },
      { code: 102, msg: 'dos' },
      { code: 5, msg: 'formato' },
    ]);
    expect(() => checkServiceErrors(result, 'WSMTXCA')).toThrow(ArcaServiceError);
  });

  it('WSFECRED: arrayErroresFormato.codigoDescripcionString[] (XSD)', () => {
    const result = {
      arrayErroresFormato: {
        codigoDescripcionString: [
          { codigo: 'FMT01', descripcion: 'Formato inválido' },
          { codigo: 7, descripcion: 'otro' },
        ],
      },
    };
    expect(extractServiceErrors(result)).toEqual([
      { code: 0, msg: 'Formato inválido', rawCode: 'FMT01' },
      { code: 7, msg: 'otro' },
    ]);
    expect(() => checkServiceErrors(result, 'WSFECRED')).toThrow(/\[FMT01\] Formato inválido/);
  });

  it('arrayErrores también acepta codigoDescripcionString', () => {
    const result = { arrayErrores: { codigoDescripcionString: { codigo: 404, descripcion: 'no existe' } } };
    expect(extractServiceErrors(result)).toEqual([{ code: 404, msg: 'no existe' }]);
    expect(() => checkServiceErrors(result, 'WSFECRED')).toThrow(ArcaServiceError);
  });

  it('WSLPG: erroresFormato.error[] (mismo tipo que errores)', () => {
    const result = {
      errores: { error: { codigo: 1, descripcion: 'negocio' } },
      erroresFormato: {
        error: [
          { codigo: 'CTG01', descripcion: 'Campo precioRefTn mal formado' },
          { codigo: 2, descripcion: 'fecha' },
        ],
      },
    };
    expect(extractServiceErrors(result)).toEqual([
      { code: 1, msg: 'negocio' },
      { code: 0, msg: 'Campo precioRefTn mal formado', rawCode: 'CTG01' },
      { code: 2, msg: 'fecha' },
    ]);
    expect(() => checkServiceErrors({ erroresFormato: result.erroresFormato }, 'WSLPG')).toThrow(
      /\[CTG01\] Campo precioRefTn mal formado, \[2\] fecha/,
    );
    expect(extractServiceErrors({ erroresFormato: '' })).toEqual([]);
  });

  it('WSCPE / WSLPG: errores.error[]', () => {
    const result = { errores: { error: [{ codigo: 'CPE-1', descripcion: 'Patente inválida' }, { codigo: '12', descripcion: 'x' }] } };
    const errors = extractServiceErrors(result);
    expect(errors).toEqual([
      { code: 0, msg: 'Patente inválida', rawCode: 'CPE-1' },
      { code: 12, msg: 'x' },
    ]);
    const err = (() => {
      try {
        checkServiceErrors(result, 'WSCPE');
      } catch (e) {
        return e as ArcaServiceError;
      }
    })();
    expect(err).toBeInstanceOf(ArcaServiceError);
    expect(err?.message).toContain('[CPE-1] Patente inválida');
    expect(err?.errors[0].rawCode).toBe('CPE-1');
  });

  it('un código no numérico lanza aunque code sea 0', () => {
    expect(() => checkServiceErrors({ errores: { error: { codigo: 'ABC', descripcion: 'x' } } }, 'X')).toThrow(ArcaServiceError);
  });

  it('sin errores no lanza y devuelve []', () => {
    expect(extractServiceErrors({ resultado: 'A' })).toEqual([]);
    expect(extractServiceErrors({ Errors: '' })).toEqual([]);
    expect(() => checkServiceErrors({ resultado: 'A' }, 'X')).not.toThrow();
  });
});

describe('parseNumbers', () => {
  const RESPONSE = soapEnvelope(
    '<ns2:getPersonaResponse xmlns:ns2="http://a/"><personaReturn>' +
      '<valor>10.50</valor><exp>1E3</exp><cero>007</cero><entero>42</entero><cuit>20111111112</cuit>' +
      '<attr id="12">5</attr></personaReturn></ns2:getPersonaResponse>',
  );

  it('default (true): convierte los textos numéricos de menos de 8 dígitos', async () => {
    mockFetch(xmlResponse(RESPONSE));
    const result = await afipSoapCall(URL, 'http://a/', 'getPersona', {});
    expect(result).toMatchObject({ valor: 10.5, exp: 1000, entero: 42, cuit: '20111111112' });
  });

  it('false: todos los valores de texto quedan como string (afipSoapCall)', async () => {
    mockFetch(xmlResponse(RESPONSE));
    const result = await afipSoapCall(URL, 'http://a/', 'getPersona', {}, { parseNumbers: false });
    expect(result).toEqual({
      valor: '10.50',
      exp: '1E3',
      cero: '007',
      entero: '42',
      cuit: '20111111112',
      attr: { '@_id': '12', '#text': '5' },
    });
  });

  it('false en soapCall: sin conversión y sin prefijos de namespace', async () => {
    mockFetch(xmlResponse(RESPONSE));
    const parsed = await soapCall(URL, '<x/>', { parseNumbers: false });
    const body = (parsed.Envelope as Record<string, Record<string, Record<string, unknown>>>).Body;
    expect(body.getPersonaResponse.personaReturn).toMatchObject({ valor: '10.50', exp: '1E3', entero: '42' });
  });

  it('false sigue detectando SOAP Faults', async () => {
    mockFetch(xmlResponse(soapFault('soap:Server', 'Error 500'), 500));
    const err = await soapCall(URL, '<x/>', { parseNumbers: false, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ArcaSoapError);
    expect(err.faultString).toBe('Error 500');
  });

  it('parseXml: default convierte, parseNumbers: false no', () => {
    const xml = '<root><a>10.50</a><b>1E3</b><c>3</c></root>';
    expect(parseXml(xml)).toEqual({ root: { a: 10.5, b: 1000, c: 3 } });
    expect(parseXml(xml, { parseNumbers: false })).toEqual({ root: { a: '10.50', b: '1E3', c: '3' } });
    expect(parseXml(xml, { parseNumbers: true })).toEqual({ root: { a: 10.5, b: 1000, c: 3 } });
  });
});
