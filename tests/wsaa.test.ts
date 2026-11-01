import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WsaaClient } from '../src/wsaa.js';
import { FileTicketStorage, MemoryTicketStorage } from '../src/ticket-storage.js';
import { ArcaAuthError, ArcaSoapError, ArcaTicketVigenteError } from '../src/errors.js';
import type { ArcaEvent } from '../src/types.js';
import { loginResponse, mockFetch, soapFault, testCert, xmlResponse } from './helpers.js';

const HOUR = 3_600_000;

function client(extra: Partial<ConstructorParameters<typeof WsaaClient>[0]> = {}) {
  return new WsaaClient({ ...testCert(), retries: 0, ...extra });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WsaaClient: ticketStorage', () => {
  it('después de un login persiste el ticket como JSON', async () => {
    const storage = new MemoryTicketStorage();
    mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    const wsaa = client({ ticketStorage: storage });

    const ticket = await wsaa.getAccessTicket('wsfe');
    expect(ticket.token).toBe('T1');
    expect(typeof ticket.expirationTime).toBe('string');

    const stored = await storage.get(wsaa.ticketKey('wsfe'));
    expect(stored).toEqual(ticket);
  });

  it('un proceso nuevo reutiliza el ticket del storage sin loguearse', async () => {
    const storage = new MemoryTicketStorage();
    mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    await client({ ticketStorage: storage }).getAccessTicket('wsfe');

    const fetch = mockFetch();
    const events: ArcaEvent[] = [];
    const ticket = await client({ ticketStorage: storage, onEvent: (e) => events.push(e) }).getAccessTicket('wsfe');
    expect(ticket.token).toBe('T1');
    expect(fetch).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: 'auth:cache-hit', service: 'wsfe', source: 'storage' });
  });

  it('ignora un ticket vencido del storage y se loguea', async () => {
    const storage = new MemoryTicketStorage();
    const wsaa = client({ ticketStorage: storage });
    await storage.set(wsaa.ticketKey('wsfe'), {
      token: 'VIEJO',
      sign: 's',
      expirationTime: new Date(Date.now() - HOUR).toISOString(),
    });
    mockFetch(xmlResponse(loginResponse('NUEVO', new Date(Date.now() + 12 * HOUR))));
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('NUEVO');
  });

  it('acepta tickets con fechas como Date o epoch (storages legacy)', async () => {
    const wsaa = client({
      ticketStorage: {
        get: async () =>
          ({ token: 'T', sign: 's', expirationTime: Date.now() + HOUR }) as never,
        set: async () => {},
      },
    });
    mockFetch();
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('T');
  });

  it('deduplica logins concurrentes (incluida la lectura del storage)', async () => {
    const fetch = mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    const wsaa = client({ ticketStorage: new MemoryTicketStorage() });
    const [a, b, c] = await Promise.all([
      wsaa.getAccessTicket('wsfe'),
      wsaa.getAccessTicket('wsfe'),
      wsaa.getAccessTicket('wsfe'),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('clearTicket borra de memoria y del storage', async () => {
    const storage = new MemoryTicketStorage();
    mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    const wsaa = client({ ticketStorage: storage });
    await wsaa.getAccessTicket('wsfe');
    await wsaa.clearTicket('wsfe');
    expect(await storage.get(wsaa.ticketKey('wsfe'))).toBeNull();
  });

  it('la key separa entorno y certificado', () => {
    const homo = client();
    const prod = client({ production: true });
    expect(homo.ticketKey('wsfe')).toMatch(/^homo:[0-9a-f]{16}:wsfe$/);
    expect(prod.ticketKey('wsfe')).toMatch(/^prod:[0-9a-f]{16}:wsfe$/);
  });

  it('un error del storage no impide loguearse', async () => {
    const events: ArcaEvent[] = [];
    mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    const wsaa = client({
      onEvent: (e) => events.push(e),
      ticketStorage: {
        get: async () => {
          throw new Error('db caída');
        },
        set: async () => {
          throw new Error('db caída');
        },
      },
    });
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('T1');
    expect(events.filter((e) => e.type === 'auth:storage-error')).toHaveLength(2);
  });
});

describe('WsaaClient: TA vigente', () => {
  const alreadyAuth = () =>
    xmlResponse(
      soapFault('ns1:coe.alreadyAuthenticated', 'El CEE ya posee un TA valido para el acceso al WSN solicitado'),
      500,
    );

  it('sin ticket en el storage lanza ArcaTicketVigenteError', async () => {
    mockFetch(alreadyAuth());
    const err = await client({ ticketStorage: new MemoryTicketStorage() })
      .getAccessTicket('wsfe')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ArcaTicketVigenteError);
    expect(err).toBeInstanceOf(ArcaAuthError);
    expect(err.code).toBe('ARCA_TICKET_VIGENTE');
    expect(err.service).toBe('wsfe');
    expect(err.message).toMatch(/esperar a que venza/);
  });

  it('si otro proceso guardó el ticket mientras tanto, lo usa', async () => {
    const storage = new MemoryTicketStorage();
    const wsaa = client({ ticketStorage: storage });
    mockFetch(async () => {
      // Otro proceso ganó la carrera y guardó su ticket.
      await storage.set(wsaa.ticketKey('wsfe'), {
        token: 'OTRO',
        sign: 's',
        expirationTime: new Date(Date.now() + HOUR).toISOString(),
      });
      return alreadyAuth();
    });
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('OTRO');
  });
});

describe('WsaaClient: desfase de reloj', () => {
  it('ajusta el offset con el header Date, reintenta una vez y emite auth:clock-skew', async () => {
    const serverNow = new Date(Date.now() + 2 * HOUR);
    const events: ArcaEvent[] = [];
    const fetch = mockFetch(
      xmlResponse(soapFault('ns1:xml.generationTime.invalid', 'generationTime posee formato o dato inválido'), 500, {
        date: serverNow.toUTCString(),
      }),
      xmlResponse(loginResponse('T1', new Date(serverNow.getTime() + 12 * HOUR))),
    );
    const wsaa = client({ onEvent: (e) => events.push(e) });

    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('T1');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(Math.abs(wsaa.clockOffsetMs - 2 * HOUR)).toBeLessThan(5_000);
    expect(events.find((e) => e.type === 'auth:clock-skew')).toMatchObject({ previousOffsetMs: 0 });

    // El TRA del reintento usa el reloj corregido.
    const body = (fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string;
    expect(body).toContain('<loginCms');
  });

  it('con autoClockSkew: false no reintenta', async () => {
    const fetch = mockFetch(
      xmlResponse(soapFault('ns1:xml.generationTime.invalid', 'generationTime inválido'), 500, {
        date: new Date().toUTCString(),
      }),
    );
    await expect(client({ autoClockSkew: false }).getAccessTicket('wsfe')).rejects.toBeInstanceOf(ArcaAuthError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('clockOffsetMs se usa para evaluar el vencimiento', async () => {
    const storage = new MemoryTicketStorage();
    // Vence en 1h según ARCA, pero el reloj de ARCA está 2h adelantado: ya venció.
    const wsaa = client({ ticketStorage: storage, clockOffsetMs: 2 * HOUR });
    await storage.set(wsaa.ticketKey('wsfe'), {
      token: 'T',
      sign: 's',
      expirationTime: new Date(Date.now() + HOUR).toISOString(),
    });
    mockFetch(xmlResponse(loginResponse('NUEVO', new Date(Date.now() + 14 * HOUR))));
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('NUEVO');
  });
});

describe('FileTicketStorage', () => {
  it('guarda un archivo por key con permisos 0600 y lo lee', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arca-tickets-'));
    try {
      const storage = new FileTicketStorage(dir);
      const ticket = { token: 't', sign: 's', expirationTime: new Date(Date.now() + HOUR).toISOString() };
      await storage.set('homo:abc:wsfe', ticket);
      expect(await storage.get('homo:abc:wsfe')).toEqual(ticket);
      expect(await storage.get('homo:abc:wsfex')).toBeNull();

      const [file] = await readdir(dir);
      expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);

      await storage.delete('homo:abc:wsfe');
      expect(await storage.get('homo:abc:wsfe')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('WsaaClient: regresiones', () => {
  const alreadyAuth = () =>
    xmlResponse(soapFault('ns1:coe.alreadyAuthenticated', 'El CEE ya posee un TA valido para el acceso al WSN solicitado'), 500);

  it('en los 2 minutos previos al vencimiento usa el ticket vigente si WSAA no permite renovarlo', async () => {
    const storage = new MemoryTicketStorage();
    const wsaa = client({ ticketStorage: storage });
    await storage.set(wsaa.ticketKey('wsfe'), {
      token: 'POR_VENCER',
      sign: 's',
      expirationTime: new Date(Date.now() + 90_000).toISOString(),
    });
    const fetch = mockFetch(alreadyAuth());

    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('POR_VENCER');
    // No reintenta el login en cada llamada mientras siga vigente.
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('POR_VENCER');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('un callback onEvent que lanza no hace perder el ticket obtenido', async () => {
    const storage = new MemoryTicketStorage();
    mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    const wsaa = client({
      ticketStorage: storage,
      onEvent: () => {
        throw new Error('logger roto');
      },
    });
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('T1');
    expect((await storage.get(wsaa.ticketKey('wsfe')))?.token).toBe('T1');
  });

  it('cancelar la espera lanza ArcaSoapError aborted (no un DOMException)', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    const err = await client().getAccessTicket('wsfe', { signal: controller.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(ArcaSoapError);
    expect(err).toMatchObject({ aborted: true, uncertain: false });
  });
});

// ---------------------------------------------------------------------------
// 0.4.0
// ---------------------------------------------------------------------------

import { inspect } from 'node:util';
import { chmod, mkdir, writeFile, readFile } from 'node:fs/promises';
import forge from 'node-forge';

/** Extrae el TRA (XML) firmado del body de un loginCms. */
function traFromBody(body: string): string {
  const b64 = /<in0>([^<]+)<\/in0>/.exec(body)![1];
  const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.decode64(b64))) as unknown as {
    rawCapture: { content: forge.asn1.Asn1 };
  };
  // content: [OCTET STRING] con el TRA
  const content = p7.rawCapture.content as unknown as { value: Array<{ value: string | Array<{ value: string }> }> };
  const first = content.value[0];
  const bytes = typeof first.value === 'string' ? first.value : first.value.map((v) => v.value).join('');
  return forge.util.decodeUtf8(bytes);
}

function bodyOf(fetch: ReturnType<typeof mockFetch>, call: number): string {
  return (fetch.mock.calls[call] as unknown as [string, RequestInit])[1].body as string;
}

describe('WsaaClient: secretos', () => {
  it('cert y key no aparecen en JSON.stringify ni util.inspect', async () => {
    const { cert, key } = testCert();
    mockFetch(xmlResponse(loginResponse('TOKEN_SECRETO', new Date(Date.now() + 12 * HOUR))));
    const wsaa = client();
    await wsaa.getAccessTicket('wsfe');
    const certBody = cert.split('\n')[1];
    const keyBody = key.split('\n')[1];
    for (const out of [JSON.stringify(wsaa), inspect(wsaa, { depth: 10, showHidden: true })]) {
      expect(out).not.toContain('BEGIN');
      expect(out).not.toContain(certBody);
      expect(out).not.toContain(keyBody);
      expect(out).not.toContain('TOKEN_SECRETO');
    }
  });
});

describe('WsaaClient: cooldown tras login fallido', () => {
  const certFault = () => xmlResponse(soapFault('ns1:cms.cert.untrusted', 'Certificado no emitido por AC de confianza'), 500);

  it('rechaza sin llamar a WSAA durante loginErrorCooldownMs, con cause', async () => {
    const fetch = mockFetch(certFault());
    const wsaa = client();
    const first = await wsaa.getAccessTicket('wsfe').catch((e) => e);
    expect(first).toBeInstanceOf(ArcaAuthError);

    const second = await wsaa.getAccessTicket('wsfe').catch((e) => e);
    expect(second).toBeInstanceOf(ArcaAuthError);
    expect(second.message).toMatch(/loginErrorCooldownMs/);
    expect(second.cause).toBeInstanceOf(ArcaSoapError);
    expect(second.cause.faultCode).toBe('ns1:cms.cert.untrusted');
    expect(fetch).toHaveBeenCalledTimes(1);

    // Otro servicio no está afectado.
    mockFetch(xmlResponse(loginResponse('T2', new Date(Date.now() + 12 * HOUR))));
    expect((await wsaa.getAccessTicket('ws_sr_padron_a13')).token).toBe('T2');
  });

  it('clearTicket limpia el cooldown', async () => {
    mockFetch(certFault());
    const wsaa = client();
    await wsaa.getAccessTicket('wsfe').catch(() => {});
    await wsaa.clearTicket('wsfe');
    mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('T1');

    mockFetch(certFault());
    const other = client();
    await other.getAccessTicket('wsfe').catch(() => {});
    await other.clearAllTickets();
    mockFetch(xmlResponse(loginResponse('T3', new Date(Date.now() + 12 * HOUR))));
    expect((await other.getAccessTicket('wsfe')).token).toBe('T3');
  });

  it('vence después de loginErrorCooldownMs; 0 lo desactiva', async () => {
    mockFetch(certFault());
    const wsaa = client({ loginErrorCooldownMs: 20 });
    await wsaa.getAccessTicket('wsfe').catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('T1');

    const fetch = mockFetch(certFault(), certFault());
    const noCooldown = client({ loginErrorCooldownMs: 0 });
    await noCooldown.getAccessTicket('wsfe').catch(() => {});
    await noCooldown.getAccessTicket('wsfe').catch(() => {});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('no aplica a errores de red sin enviar ni a desfase de reloj', async () => {
    const notSent = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
    let fetch = mockFetch(notSent, xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    const wsaa = client();
    await expect(wsaa.getAccessTicket('wsfe')).rejects.toBeInstanceOf(ArcaAuthError);
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('T1');
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch = mockFetch(
      xmlResponse(soapFault('ns1:xml.generationTime.invalid', 'generationTime posee formato o dato inválido'), 500),
      xmlResponse(loginResponse('T2', new Date(Date.now() + 12 * HOUR))),
    );
    const skew = client({ autoClockSkew: false });
    await expect(skew.getAccessTicket('wsfe')).rejects.toBeInstanceOf(ArcaAuthError);
    expect((await skew.getAccessTicket('wsfe')).token).toBe('T2');
  });
});

describe('WsaaClient: errores de reloj', () => {
  it('xml.expirationTime.invalid (vigencia > 24h) no se trata como desfase de reloj', async () => {
    const events: ArcaEvent[] = [];
    const fetch = mockFetch(
      xmlResponse(soapFault('ns1:xml.expirationTime.invalid', 'expirationTime posee formato o dato inválido'), 500, {
        date: new Date(Date.now() + 2 * HOUR).toUTCString(),
      }),
    );
    const wsaa = client({ onEvent: (e) => events.push(e) });
    await expect(wsaa.getAccessTicket('wsfe')).rejects.toBeInstanceOf(ArcaAuthError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(wsaa.clockOffsetMs).toBe(0);
    expect(events.some((e) => e.type === 'auth:clock-skew')).toBe(false);
  });

  it('xml.expirationTime.expired sí es desfase de reloj', async () => {
    const serverNow = new Date(Date.now() + 14 * HOUR);
    const fetch = mockFetch(
      xmlResponse(soapFault('ns1:xml.expirationTime.expired', 'expirationTime posee una fecha anterior a la actual'), 500, {
        date: serverNow.toUTCString(),
      }),
      xmlResponse(loginResponse('T1', new Date(serverNow.getTime() + 12 * HOUR))),
    );
    expect((await client().getAccessTicket('wsfe')).token).toBe('T1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('WsaaClient: TRA', () => {
  it('uniqueId distinto en TRAs del mismo segundo y dentro de unsignedInt', async () => {
    const fetch = mockFetch(
      xmlResponse(loginResponse('A', new Date(Date.now() + 12 * HOUR))),
      xmlResponse(loginResponse('B', new Date(Date.now() + 12 * HOUR))),
    );
    const wsaa = client();
    await wsaa.getAccessTicket('wsfe');
    await wsaa.getAccessTicket('wsmtxca');
    const ids = [0, 1].map((i) => Number(/<uniqueId>(\d+)<\/uniqueId>/.exec(traFromBody(bodyOf(fetch, i)))![1]));
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('usa el fetch inyectado en la config', async () => {
    const global = mockFetch();
    const own = vi.fn(async () => xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
    const wsaa = client({ fetch: own as unknown as typeof fetch });
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('T1');
    expect(own).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });
});

describe('WsaaClient: carrera alreadyAuthenticated', () => {
  it('relee el storage unos instantes antes de lanzar ArcaTicketVigenteError', async () => {
    const storage = new MemoryTicketStorage();
    const wsaa = client({ ticketStorage: storage });
    mockFetch(async () => {
      // El otro proceso guarda su ticket un rato después de que WSAA nos rechaza.
      setTimeout(() => {
        void storage.set(wsaa.ticketKey('wsfe'), {
          token: 'TARDIO',
          sign: 's',
          expirationTime: new Date(Date.now() + HOUR).toISOString(),
        });
      }, 100);
      return xmlResponse(
        soapFault('ns1:coe.alreadyAuthenticated', 'El CEE ya posee un TA valido para el acceso al WSN solicitado'),
        500,
      );
    });
    expect((await wsaa.getAccessTicket('wsfe')).token).toBe('TARDIO');
  });
});

describe('FileTicketStorage: robustez', () => {
  it('un JSON corrupto se borra, devuelve null y WsaaClient emite auth:storage-error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arca-tickets-'));
    try {
      const storage = new FileTicketStorage(dir);
      await storage.set('k', { token: 't', sign: 's', expirationTime: new Date(Date.now() + HOUR).toISOString() });
      const [file] = await readdir(dir);
      await writeFile(join(dir, file), '{"token": "t", "sig');
      const onError = vi.fn();
      expect(await storage.get('k', { onError })).toBeNull();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(await readdir(dir)).toEqual([]);

      // A través de WsaaClient
      const events: ArcaEvent[] = [];
      const wsaa = client({ ticketStorage: storage, onEvent: (e) => events.push(e) });
      await writeFile(join(dir, `${wsaa.ticketKey('wsfe').replace(/[^a-zA-Z0-9._-]/g, '_')}.json`), 'no es json');
      mockFetch(xmlResponse(loginResponse('T1', new Date(Date.now() + 12 * HOUR))));
      expect((await wsaa.getAccessTicket('wsfe')).token).toBe('T1');
      expect(events).toContainEqual(expect.objectContaining({ type: 'auth:storage-error', operation: 'get' }));
      // El ticket nuevo reemplazó al corrupto.
      expect((await storage.get(wsaa.ticketKey('wsfe')))?.token).toBe('T1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no deja temporales y restringe a 0700 un directorio propio existente', async () => {
    const base = await mkdtemp(join(tmpdir(), 'arca-tickets-'));
    const dir = join(base, 'tickets');
    try {
      await mkdir(dir, { mode: 0o755 });
      await chmod(dir, 0o755);
      const storage = new FileTicketStorage(dir);
      const ticket = { token: 't', sign: 's', expirationTime: new Date(Date.now() + HOUR).toISOString() };
      await Promise.all([storage.set('a', ticket), storage.set('a', ticket), storage.set('b', ticket)]);
      expect((await readdir(dir)).sort()).toEqual(['a.json', 'b.json']);
      expect(JSON.parse(await readFile(join(dir, 'a.json'), 'utf8'))).toEqual(ticket);
      if (process.platform !== 'win32') {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
