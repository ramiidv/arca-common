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
