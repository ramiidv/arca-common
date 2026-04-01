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
  const b1w = [7, 1, 3, 7, 1, 3, 7];
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
  const b2w = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3];
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

/**
 * Formatea una fecha al formato YYYYMMDD que usa AFIP/ARCA.
 * Acepta Date o string. Si recibe un string en formato YYYYMMDD, lo devuelve tal cual.
 * Usa timezone Argentina (UTC-3).
 */
export function formatDate(date: Date | string): string {
  if (typeof date === 'string') {
    if (/^\d{8}$/.test(date)) return date;
    // Intentar parsear ISO u otros formatos
    const parsed = new Date(date);
    if (isNaN(parsed.getTime())) {
      throw new ArcaValidationError(
        `Fecha inválida: "${date}"`,
        [{ field: 'fecha', message: 'No se pudo parsear la fecha', value: date }],
        'fecha',
      );
    }
    date = parsed;
  }

  // Formatear en timezone Argentina (UTC-3)
  const ar = new Date(date.getTime() - 3 * 60 * 60_000 + date.getTimezoneOffset() * 60_000);
  const y = ar.getFullYear();
  const m = String(ar.getMonth() + 1).padStart(2, '0');
  const d = String(ar.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Parsea una fecha en formato YYYYMMDD (usado por AFIP/ARCA) a Date.
 * También acepta YYYY-MM-DD.
 */
export function parseAfipDate(dateStr: string): Date {
  const clean = dateStr.replace(/-/g, '');
  if (!/^\d{8}$/.test(clean)) {
    throw new ArcaValidationError(
      `Fecha AFIP inválida: "${dateStr}". Formato esperado: YYYYMMDD.`,
      [{ field: 'fecha', message: 'Formato de fecha inválido, se espera YYYYMMDD', value: dateStr }],
      'fecha',
    );
  }
  const y = parseInt(clean.slice(0, 4), 10);
  const m = parseInt(clean.slice(4, 6), 10) - 1;
  const d = parseInt(clean.slice(6, 8), 10);
  return new Date(y, m, d);
}

/**
 * Valida que un valor sea un Date válido.
 * @throws ArcaValidationError si la fecha es inválida.
 */
export function validateFecha(date: Date, fieldName: string): void {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new ArcaValidationError(
      `Fecha inválida en campo "${fieldName}".`,
      [{ field: fieldName, message: 'La fecha no es válida', value: date }],
      fieldName,
    );
  }
}

/**
 * Valida que fechaFin sea posterior a fechaInicio.
 * @throws ArcaValidationError si fechaFin no es posterior a fechaInicio.
 */
export function validateFechaRango(fechaInicio: Date, fechaFin: Date | undefined): void {
  if (fechaFin === undefined) return;

  validateFecha(fechaInicio, 'fechaInicio');
  validateFecha(fechaFin, 'fechaFin');

  if (fechaFin.getTime() <= fechaInicio.getTime()) {
    throw new ArcaValidationError(
      'La fecha de fin debe ser posterior a la fecha de inicio.',
      [{
        field: 'fechaFin',
        message: `fechaFin (${fechaFin.toISOString()}) debe ser posterior a fechaInicio (${fechaInicio.toISOString()})`,
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
 */
export function collectErrors(fn: () => void, errors: ValidationErrorDetail[]): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ArcaValidationError) {
      errors.push(...e.details);
    }
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
    }
  }
}
