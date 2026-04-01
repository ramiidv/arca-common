import { ArcaValidationError } from './errors.js';
import type { ValidationErrorDetail } from './errors.js';

// ---------------------------------------------------------------------------
// CUIL / CUIT
// ---------------------------------------------------------------------------

const CUIL_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
const VALID_PREFIXES = [20, 23, 24, 27, 30, 33, 34];

/**
 * Elimina guiones de un CUIL/CUIT, retornando los 11 dígitos.
 */
export function normalizeCuil(cuil: string): string {
  return cuil.replace(/-/g, '');
}

/**
 * Formatea un CUIL/CUIT como XX-XXXXXXXX-X.
 */
export function formatCuil(cuil: string): string {
  const normalized = normalizeCuil(cuil);
  return `${normalized.slice(0, 2)}-${normalized.slice(2, 10)}-${normalized.slice(10)}`;
}

/**
 * Valida un CUIL/CUIT (formato y dígito verificador).
 * Acepta formato XX-XXXXXXXX-X o XXXXXXXXXXX.
 * Retorna el CUIL/CUIT normalizado (11 dígitos).
 * @throws ArcaValidationError si el CUIL/CUIT es inválido.
 */
export function validateCuil(cuil: string): string {
  const normalized = normalizeCuil(cuil);

  if (!/^\d{11}$/.test(normalized)) {
    throw new ArcaValidationError(
      `CUIL/CUIT inválido: "${cuil}". Debe tener 11 dígitos.`,
      [{ field: 'cuil', message: 'El CUIL/CUIT debe tener 11 dígitos numéricos', value: cuil }],
      'cuil',
    );
  }

  const prefix = parseInt(normalized.slice(0, 2), 10);
  if (!VALID_PREFIXES.includes(prefix)) {
    throw new ArcaValidationError(
      `CUIL/CUIT inválido: "${cuil}". Prefijo ${prefix} no es válido.`,
      [{ field: 'cuil', message: `Prefijo ${prefix} no es un prefijo CUIL/CUIT válido`, value: cuil }],
      'cuil',
    );
  }

  // Validación de dígito verificador
  const digits = normalized.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += digits[i] * CUIL_WEIGHTS[i];
  }

  const remainder = sum % 11;
  let expectedCheck: number;

  if (remainder === 0) {
    expectedCheck = 0;
  } else if (remainder === 1) {
    // 11 - 1 = 10, no representable en un dígito.
    // AFIP ajusta el prefijo (ej: 20→23 o 27→23) para evitar este caso.
    throw new ArcaValidationError(
      `CUIL/CUIT inválido: "${cuil}". Dígito verificador no puede ser calculado (remainder=1).`,
      [{ field: 'cuil', message: 'CUIL/CUIT con dígito verificador inválido (remainder=1)', value: cuil }],
      'cuil',
    );
  } else {
    expectedCheck = 11 - remainder;
  }

  if (digits[10] !== expectedCheck) {
    throw new ArcaValidationError(
      `CUIL/CUIT inválido: "${cuil}". Dígito verificador incorrecto (esperado: ${expectedCheck}, recibido: ${digits[10]}).`,
      [{
        field: 'cuil',
        message: `Dígito verificador incorrecto (esperado: ${expectedCheck}, recibido: ${digits[10]})`,
        value: cuil,
      }],
      'cuil',
    );
  }

  return normalized;
}

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
  const block1 = cbu.slice(0, 8);
  const block1Digits = block1.split('').map(Number);
  const block1Weights = [7, 1, 3, 7, 1, 3, 7];
  let block1Sum = 0;
  for (let i = 0; i < 7; i++) {
    block1Sum += block1Digits[i] * block1Weights[i];
  }
  const block1Check = (10 - (block1Sum % 10)) % 10;
  if (block1Digits[7] !== block1Check) {
    throw new ArcaValidationError(
      `CBU inválido: "${cbu}". Dígito verificador del bloque 1 incorrecto.`,
      [{
        field: 'cbu',
        message: `Dígito verificador del bloque 1 incorrecto (esperado: ${block1Check}, recibido: ${block1Digits[7]})`,
        value: cbu,
      }],
      'cbu',
    );
  }

  // Bloque 2: últimos 14 dígitos (número de cuenta + dígito verificador)
  const block2 = cbu.slice(8, 22);
  const block2Digits = block2.split('').map(Number);
  const block2Weights = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3];
  let block2Sum = 0;
  for (let i = 0; i < 13; i++) {
    block2Sum += block2Digits[i] * block2Weights[i];
  }
  const block2Check = (10 - (block2Sum % 10)) % 10;
  if (block2Digits[13] !== block2Check) {
    throw new ArcaValidationError(
      `CBU inválido: "${cbu}". Dígito verificador del bloque 2 incorrecto.`,
      [{
        field: 'cbu',
        message: `Dígito verificador del bloque 2 incorrecto (esperado: ${block2Check}, recibido: ${block2Digits[13]})`,
        value: cbu,
      }],
      'cbu',
    );
  }

  return cbu;
}

// ---------------------------------------------------------------------------
// Fecha
// ---------------------------------------------------------------------------

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
// Helpers para recolección de errores
// ---------------------------------------------------------------------------

/**
 * Ejecuta una función de validación y recolecta errores en el array provisto
 * en vez de lanzar.
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
