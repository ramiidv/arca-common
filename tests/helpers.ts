import forge from 'node-forge';
import { vi } from 'vitest';

/** Respuesta HTTP simulada para `fetch`. */
export function xmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'text/xml', ...headers },
  });
}

/** Reemplaza `fetch` global por un mock que devuelve las respuestas en orden. */
export function mockFetch(...responses: Array<Response | Error | (() => Response | Promise<Response>)>) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('fetch llamado más veces de lo esperado');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function soapEnvelope(inner: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`
  );
}

export function soapFault(faultCode: string, faultString: string): string {
  return soapEnvelope(
    '<soapenv:Fault>' +
      `<faultcode xmlns:ns1="http://xml.apache.org/axis/">${faultCode}</faultcode>` +
      `<faultstring>${faultString}</faultstring>` +
      '</soapenv:Fault>',
  );
}

/** Respuesta de loginCms tal como la devuelve WSAA (el TA viene escapado dentro de loginCmsReturn). */
export function loginResponse(token: string, expiration: Date, generation = new Date()): string {
  const ta =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<loginTicketResponse version="1.0"><header>' +
    '<source>CN=wsaahomo, O=AFIP, C=AR, SERIALNUMBER=CUIT 33693450239</source>' +
    '<destination>SERIALNUMBER=CUIT 20123456789, CN=test</destination>' +
    '<uniqueId>123456</uniqueId>' +
    `<generationTime>${generation.toISOString()}</generationTime>` +
    `<expirationTime>${expiration.toISOString()}</expirationTime>` +
    '</header><credentials>' +
    `<token>${token}</token><sign>sign-${token}</sign>` +
    '</credentials></loginTicketResponse>';
  const escaped = ta.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return soapEnvelope(
    `<loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>${escaped}</loginCmsReturn></loginCmsResponse>`,
  );
}

let cachedCert: { cert: string; key: string } | undefined;

/** Certificado autofirmado para firmar TRAs en tests. */
export function testCert(): { cert: string; key: string } {
  if (cachedCert) return cachedCert;
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  cachedCert = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
  return cachedCert;
}
