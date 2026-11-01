import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import type { AccessTicket, TicketStorage, TicketStorageGetOptions } from './types.js';

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
 * - Escritura atómica y durable (archivo temporal con nombre aleatorio +
 *   `fsync` + rename), así un corte de luz no deja un archivo a medio escribir.
 * - Los archivos se crean con permisos 0600 y el directorio con 0700 (si ya
 *   existe y es del usuario actual, se le ajustan los permisos): el token y el
 *   sign dan acceso a los web services de ARCA con tu CUIT.
 * - Un archivo con JSON corrupto se borra y se trata como inexistente (se
 *   informa por `options.onError`, que `WsaaClient` emite como `auth:storage-error`).
 * - Seguro para varios procesos que comparten el directorio (cada key es un archivo).
 *
 * @example
 * ```ts
 * const arca = new Arca({ ..., ticketStorage: new FileTicketStorage("./.arca-tickets") });
 * ```
 */
export class FileTicketStorage implements TicketStorage {
  private directoryReady = false;

  constructor(private readonly directory: string) {}

  async get(key: string, options?: TicketStorageGetOptions): Promise<AccessTicket | null> {
    const path = this.pathFor(key);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      return normalizeAccessTicket(JSON.parse(raw));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // Archivo corrupto: se descarta para que el próximo login lo reemplace.
      await rm(path, { force: true }).catch(() => {});
      try {
        options?.onError?.(new Error(`Ticket corrupto en ${path} (descartado): ${err.message}`, { cause: err }));
      } catch {
        // Un callback que falla no afecta la lectura.
      }
      return null;
    }
  }

  async set(key: string, ticket: AccessTicket): Promise<void> {
    await this.ensureDirectory();
    const target = this.pathFor(key);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(ticket), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // `mkdir` no cambia los permisos de un directorio existente: si es nuestro,
    // se restringen a 0700 (best effort, ej: en Windows no aplica). Nunca se
    // tocan el directorio actual, el home ni la raíz (alguien pasó "." o "~").
    const dir = resolve(this.directory);
    const protectedDirs = [process.cwd(), homedir(), parse(dir).root].map((d) => resolve(d));
    try {
      if (protectedDirs.includes(dir)) throw new Error('directorio protegido');
      const info = await stat(this.directory);
      const uid = process.getuid?.();
      if (uid !== undefined && info.uid === uid && (info.mode & 0o777) !== 0o700) {
        await chmod(this.directory, 0o700);
      }
    } catch {
      // Ignorado a propósito.
    }
    this.directoryReady = true;
  }

  private pathFor(key: string): string {
    return join(this.directory, `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
  }
}
