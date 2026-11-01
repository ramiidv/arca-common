import { ArcaValidationError } from './errors.js';
import type { ValidationErrorDetail } from './errors.js';

// ---------------------------------------------------------------------------
// CUIT / CUIL
// ---------------------------------------------------------------------------

const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
const VALID_PREFIXES = [20, 23, 24, 27, 30, 33, 34];

/**
 * Normaliza un CUIT/CUIL a 11 dígitos.
 * Acepta string con o sin guiones, o number.
 */
export function normalizeCuit(cuit: string | number): string {
  return String(cuit).replace(/-/g, '');
}

/**
 * Formatea un CUIT/CUIL como XX-XXXXXXXX-X.
 * Acepta string con o sin guiones, o number.
 */
export function formatCuit(cuit: string | number): string {
  const n = normalizeCuit(cuit);
  if (!/^\d{11}$/.test(n)) {
    throw new ArcaValidationError(
      `CUIT inválido: "${cuit}". Debe tener 11 dígitos.`,
      [{ field: 'cuit', message: 'El CUIT debe tener 11 dígitos numéricos', value: cuit }],
      'cuit',
    );
  }
  return `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}`;
}

/**
 * Valida un CUIT/CUIL (formato y dígito verificador).
 * Acepta formato XX-XXXXXXXX-X, XXXXXXXXXXX, o number.
 * Retorna el CUIT/CUIL normalizado (11 dígitos).
 * @throws ArcaValidationError si el CUIT/CUIL es inválido.
 */
export function validateCuit(cuit: string | number): string {
  const normalized = normalizeCuit(cuit);

  if (!/^\d{11}$/.test(normalized)) {
    throw new ArcaValidationError(
      `CUIT inválido: "${cuit}". Debe tener 11 dígitos.`,
      [{ field: 'cuit', message: 'El CUIT debe tener 11 dígitos numéricos', value: cuit }],
      'cuit',
    );
  }

  const prefix = parseInt(normalized.slice(0, 2), 10);
  if (!VALID_PREFIXES.includes(prefix)) {
    throw new ArcaValidationError(
      `CUIT inválido: "${cuit}". Prefijo ${prefix} no es válido.`,
      [{ field: 'cuit', message: `Prefijo ${prefix} no es un prefijo CUIT válido`, value: cuit }],
      'cuit',
    );
  }

  const digits = normalized.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += digits[i] * CUIT_WEIGHTS[i];
  }

  const remainder = sum % 11;
  let expectedCheck: number;

  if (remainder === 0) {
    expectedCheck = 0;
  } else if (remainder === 1) {
    throw new ArcaValidationError(
      `CUIT inválido: "${cuit}". Dígito verificador no puede ser calculado (remainder=1).`,
      [{ field: 'cuit', message: 'CUIT con dígito verificador inválido (remainder=1)', value: cuit }],
      'cuit',
    );
  } else {
    expectedCheck = 11 - remainder;
  }

  if (digits[10] !== expectedCheck) {
    throw new ArcaValidationError(
      `CUIT inválido: "${cuit}". Dígito verificador incorrecto (esperado: ${expectedCheck}, recibido: ${digits[10]}).`,
      [{
        field: 'cuit',
        message: `Dígito verificador incorrecto (esperado: ${expectedCheck}, recibido: ${digits[10]})`,
        value: cuit,
      }],
      'cuit',
    );
  }

  return normalized;
}

/**
 * Verifica si un CUIT/CUIL es válido sin lanzar error.
 * Acepta string con o sin guiones, o number.
 */
export function isValidCuit(cuit: string | number): boolean {
  try {
    validateCuit(cuit);
    return true;
  } catch {
    return false;
  }
}

// Aliases para backward compat (CUIL y CUIT usan el mismo algoritmo)
/** @deprecated Usar `validateCuit` */
export const validateCuil = validateCuit;
/** @deprecated Usar `normalizeCuit` */
export const normalizeCuil = normalizeCuit;
/** @deprecated Usar `formatCuit` */
export const formatCuil = formatCuit;

// ---------------------------------------------------------------------------
// CBU
// ---------------------------------------------------------------------------

/**
 * Valida un CBU (formato de 22 dígitos con checksums).
 * Retorna el CBU validado.
 * @throws ArcaValidationError si el CBU es inválido.
 */
export function validateCBU(cbu: string): string {
  if (!/^\d{22}$/.test(cbu)) {
    throw new ArcaValidationError(
      `CBU inválido: "${cbu}". Debe tener 22 dígitos.`,
      [{ field: 'cbu', message: 'El CBU debe tener 22 dígitos numéricos', value: cbu }],
      'cbu',
    );
  }

  // Bloque 1: primeros 8 dígitos (código banco + sucursal + dígito verificador)
  const b1 = cbu.slice(0, 8).split('').map(Number);
  // Ponderadores oficiales BCRA: 7-1-3-9 cíclico (patrón "7139713")
  const b1w = [7, 1, 3, 9, 7, 1, 3];
  let b1sum = 0;
  for (let i = 0; i < 7; i++) b1sum += b1[i] * b1w[i];
  const b1check = (10 - (b1sum % 10)) % 10;
  if (b1[7] !== b1check) {
    throw new ArcaValidationError(
      `CBU inválido: "${cbu}". Dígito verificador del bloque 1 incorrecto.`,
      [{
        field: 'cbu',
        message: `Dígito verificador del bloque 1 incorrecto (esperado: ${b1check}, recibido: ${b1[7]})`,
        value: cbu,
      }],
      'cbu',
    );
  }

  // Bloque 2: últimos 14 dígitos (número de cuenta + dígito verificador)
  const b2 = cbu.slice(8, 22).split('').map(Number);
  // Ponderadores oficiales BCRA: 3-9-7-1 cíclico (patrón "3971397139713")
  const b2w = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];
  let b2sum = 0;
  for (let i = 0; i < 13; i++) b2sum += b2[i] * b2w[i];
  const b2check = (10 - (b2sum % 10)) % 10;
  if (b2[13] !== b2check) {
    throw new ArcaValidationError(
      `CBU inválido: "${cbu}". Dígito verificador del bloque 2 incorrecto.`,
      [{
        field: 'cbu',
        message: `Dígito verificador del bloque 2 incorrecto (esperado: ${b2check}, recibido: ${b2[13]})`,
        value: cbu,
      }],
      'cbu',
    );
  }

  return cbu;
}

/**
 * Verifica si un CBU es válido sin lanzar error.
 */
export function isValidCBU(cbu: string): boolean {
  try {
    validateCBU(cbu);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const AFIP_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Zona horaria de ARCA: las fechas de los comprobantes son fechas calendario de Argentina. */
const AR_TIMEZONE = 'America/Argentina/Buenos_Aires';

let arDateFormatter: Intl.DateTimeFormat | undefined;

function invalidDate(value: unknown, field: string, message: string): ArcaValidationError {
  return new ArcaValidationError(
    `Fecha inválida en campo "${field}": "${String(value)}". ${message}`,
    [{ field, message, value }],
    field,
  );
}

/**
 * Parsea estrictamente `YYYYMMDD` o `YYYY-MM-DD` y verifica que la fecha exista
 * (sin overflow: `20230230` o mes 13 son inválidos). Devuelve año, mes (1-12) y día.
 */
function parseCalendarDate(value: string, field: string): { y: number; m: number; d: number } {
  const match = AFIP_DATE_RE.exec(value) ?? ISO_DATE_RE.exec(value);
  if (!match) {
    throw invalidDate(value, field, 'Formato esperado: YYYYMMDD o YYYY-MM-DD.');
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(0);
  probe.setUTCFullYear(y, m - 1, d);
  if (y < 1 || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw invalidDate(value, field, 'La fecha no existe.');
  }
  return { y, m, d };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Formatea una fecha al formato YYYYMMDD que usa AFIP/ARCA.
 *
 * - String `YYYYMMDD` o `YYYY-MM-DD`: se formatea literal (sin pasar por `Date`,
 *   así no hay corrimientos de zona horaria), después de validar que la fecha exista.
 * - `Date`: se toma la fecha calendario en Argentina (`America/Argentina/Buenos_Aires`).
 *
 * @throws ArcaValidationError si el string no tiene uno de esos formatos, la
 *   fecha no existe, o el `Date` es inválido.
 */
export function formatDate(date: Date | string): string {
  if (typeof date === 'string') {
    const { y, m, d } = parseCalendarDate(date, 'fecha');
    return `${pad(y, 4)}${pad(m, 2)}${pad(d, 2)}`;
  }

  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw invalidDate(date, 'fecha', 'La fecha no es válida.');
  }

  arDateFormatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: AR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = arDateFormatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return `${pad(part('year'), 4)}${pad(part('month'), 2)}${pad(part('day'), 2)}`;
}

/**
 * Parsea una fecha en formato `YYYYMMDD` (usado por AFIP/ARCA) o `YYYY-MM-DD` a `Date`.
 *
 * Devuelve el mediodía de Argentina (15:00 UTC) de ese día, así
 * `formatDate(parseAfipDate(x))` devuelve la misma fecha sin importar la zona
 * horaria del proceso.
 *
 * @throws ArcaValidationError si el formato no es exacto o la fecha no existe.
 */
export function parseAfipDate(dateStr: string): Date {
  if (typeof dateStr !== 'string') {
    throw invalidDate(dateStr, 'fecha', 'Formato esperado: YYYYMMDD o YYYY-MM-DD.');
  }
  const { y, m, d } = parseCalendarDate(dateStr, 'fecha');
  const date = new Date(Date.UTC(2000, m - 1, d, 15));
  date.setUTCFullYear(y);
  return date;
}

/** Convierte un `Date` o un string `YYYYMMDD`/`YYYY-MM-DD` a `Date`, validando con las mismas reglas. */
function toValidDate(date: Date | string, fieldName: string): Date {
  if (typeof date === 'string') {
    try {
      return parseAfipDate(date);
    } catch {
      throw invalidDate(date, fieldName, 'Formato esperado: YYYYMMDD o YYYY-MM-DD, con una fecha existente.');
    }
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new ArcaValidationError(
      `Fecha inválida en campo "${fieldName}".`,
      [{ field: fieldName, message: 'La fecha no es válida', value: date }],
      fieldName,
    );
  }
  return date;
}

/**
 * Valida que un valor sea un `Date` válido, o un string `YYYYMMDD`/`YYYY-MM-DD`
 * con una fecha existente (misma validación estricta que `parseAfipDate`).
 * @throws ArcaValidationError si la fecha es inválida.
 */
export function validateFecha(date: Date | string, fieldName: string): void {
  toValidDate(date, fieldName);
}

/**
 * Valida que fechaFin sea posterior a fechaInicio. Acepta `Date` o strings
 * `YYYYMMDD`/`YYYY-MM-DD` (validados como en `validateFecha`).
 * @throws ArcaValidationError si alguna fecha es inválida o fechaFin no es posterior a fechaInicio.
 */
export function validateFechaRango(fechaInicio: Date | string, fechaFin: Date | string | undefined): void {
  if (fechaFin === undefined) return;

  const inicio = toValidDate(fechaInicio, 'fechaInicio');
  const fin = toValidDate(fechaFin, 'fechaFin');

  if (fin.getTime() <= inicio.getTime()) {
    throw new ArcaValidationError(
      'La fecha de fin debe ser posterior a la fecha de inicio.',
      [{
        field: 'fechaFin',
        message: `fechaFin (${fin.toISOString()}) debe ser posterior a fechaInicio (${inicio.toISOString()})`,
        value: { fechaInicio, fechaFin },
      }],
      'fechaFin',
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers para recolección de errores (uso interno de SDKs)
// ---------------------------------------------------------------------------

/**
 * Ejecuta una función de validación y recolecta errores en el array provisto
 * en vez de lanzar. Útil para validar múltiples campos y reportar todos los errores juntos.
 * Solo recolecta `ArcaValidationError`: cualquier otro error (ej: un `TypeError`
 * por un bug) se re-lanza.
 */
export function collectErrors(fn: () => void, errors: ValidationErrorDetail[]): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ArcaValidationError) {
      errors.push(...e.details);
      return;
    }
    throw e;
  }
}

/**
 * Igual que collectErrors pero prefija el nombre del campo en los errores.
 */
export function collectErrorsWithPrefix(fn: () => void, errors: ValidationErrorDetail[], prefix: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ArcaValidationError) {
      errors.push(...e.details.map(err => ({
        ...err,
        field: `${prefix}.${err.field}`,
      })));
      return;
    }
    throw e;
  }
}
