import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccessTicket, TicketStorage } from './types.js';

/**
 * Normaliza un ticket leído de un storage: acepta `expirationTime` como string
 * ISO, epoch en ms o `Date`, y devuelve `null` si el valor no es un ticket válido.
 */
export function normalizeAccessTicket(raw: unknown): AccessTicket | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t['token'] !== 'string' || typeof t['sign'] !== 'string') return null;

  const expirationTime = toIso(t['expirationTime']);
  if (!expirationTime) return null;

  const ticket: AccessTicket = { token: t['token'], sign: t['sign'], expirationTime };
  const generationTime = toIso(t['generationTime']);
  if (generationTime) ticket.generationTime = generationTime;
  if (typeof t['service'] === 'string') ticket.service = t['service'];
  return ticket;
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/**
 * Storage en memoria. Útil para tests o para compartir tickets entre varias
 * instancias dentro del mismo proceso. No sobrevive a un reinicio.
 *
 * Guarda copias serializadas (como haría un storage real) para que los bugs de
 * serialización aparezcan también en los tests.
 */
export class MemoryTicketStorage implements TicketStorage {
  private readonly tickets = new Map<string, string>();

  async get(key: string): Promise<AccessTicket | null> {
    const raw = this.tickets.get(key);
    return raw ? normalizeAccessTicket(JSON.parse(raw)) : null;
  }

  async set(key: string, ticket: AccessTicket): Promise<void> {
    this.tickets.set(key, JSON.stringify(ticket));
  }

  async delete(key: string): Promise<void> {
    this.tickets.delete(key);
  }
}

/**
 * Storage en archivos: un archivo JSON por ticket dentro de `directory`.
 *
 * - Escritura atómica (archivo temporal + rename), así un corte de luz no deja
 *   un archivo a medio escribir.
 * - Los archivos se crean con permisos 0600: el token y el sign dan acceso a
 *   los web services de ARCA con tu CUIT.
 * - Seguro para varios procesos que comparten el directorio (cada key es un archivo).
 *
 * @example
 * ```ts
 * const arca = new Arca({ ..., ticketStorage: new FileTicketStorage("./.arca-tickets") });
 * ```
 */
export class FileTicketStorage implements TicketStorage {
  constructor(private readonly directory: string) {}

  async get(key: string): Promise<AccessTicket | null> {
    try {
      const raw = await readFile(this.pathFor(key), 'utf8');
      return normalizeAccessTicket(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async set(key: string, ticket: AccessTicket): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.pathFor(key);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(ticket), { mode: 0o600 });
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    return join(this.directory, `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
  }
}
