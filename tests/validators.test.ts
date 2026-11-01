import { describe, it, expect } from 'vitest';
import {
  validateCuit,
  normalizeCuit,
  formatCuit,
  isValidCuit,
  validateCuil,
  normalizeCuil,
  formatCuil,
  validateCBU,
  isValidCBU,
  formatDate,
  parseAfipDate,
  validateFecha,
  validateFechaRango,
  ArcaValidationError,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// CUIT / CUIL
// ---------------------------------------------------------------------------

describe('validateCuit', () => {
  it('validates a correct CUIT string', () => {
    expect(validateCuit('20123456786')).toBe('20123456786');
  });

  it('validates a CUIT with hyphens', () => {
    expect(validateCuit('20-12345678-6')).toBe('20123456786');
  });

  it('validates a CUIT passed as number', () => {
    expect(validateCuit(20123456786)).toBe('20123456786');
  });

  it('validates prefix 30 (persona jurídica)', () => {
    expect(validateCuit('30710158246')).toBe('30710158246');
  });

  it('validates prefix 27', () => {
    expect(validateCuit('27123456780')).toBe('27123456780');
  });

  it('throws on too short', () => {
    expect(() => validateCuit('2012345')).toThrow(ArcaValidationError);
  });

  it('throws on too long', () => {
    expect(() => validateCuit('201234567861')).toThrow(ArcaValidationError);
  });

  it('throws on non-numeric characters', () => {
    expect(() => validateCuit('2012345678a')).toThrow(ArcaValidationError);
  });

  it('throws on invalid prefix', () => {
    expect(() => validateCuit('10123456789')).toThrow(ArcaValidationError);
    expect(() => validateCuit('50123456789')).toThrow(ArcaValidationError);
  });

  it('throws on bad checksum', () => {
    expect(() => validateCuit('20123456789')).toThrow(/incorrecto/);
  });

  it('error includes field and details', () => {
    try {
      validateCuit('123');
    } catch (e) {
      expect(e).toBeInstanceOf(ArcaValidationError);
      const err = e as ArcaValidationError;
      expect(err.field).toBe('cuit');
      expect(err.details).toHaveLength(1);
      expect(err.details[0].field).toBe('cuit');
    }
  });
});

describe('normalizeCuit', () => {
  it('removes hyphens', () => {
    expect(normalizeCuit('20-12345678-6')).toBe('20123456786');
  });

  it('converts number to string', () => {
    expect(normalizeCuit(20123456786)).toBe('20123456786');
  });

  it('no-op on clean string', () => {
    expect(normalizeCuit('20123456786')).toBe('20123456786');
  });
});

describe('formatCuit', () => {
  it('formats 11 digits as XX-XXXXXXXX-X', () => {
    expect(formatCuit('20123456786')).toBe('20-12345678-6');
  });

  it('formats from number', () => {
    expect(formatCuit(20123456786)).toBe('20-12345678-6');
  });

  it('is idempotent with hyphens', () => {
    expect(formatCuit('20-12345678-6')).toBe('20-12345678-6');
  });
});

describe('isValidCuit', () => {
  it('returns true for valid CUIT', () => {
    expect(isValidCuit('20123456786')).toBe(true);
    expect(isValidCuit(20123456786)).toBe(true);
  });

  it('returns false for invalid CUIT', () => {
    expect(isValidCuit('20123456789')).toBe(false);
    expect(isValidCuit('123')).toBe(false);
    expect(isValidCuit('00000000000')).toBe(false);
  });
});

describe('backward compat aliases', () => {
  it('validateCuil is validateCuit', () => {
    expect(validateCuil).toBe(validateCuit);
  });

  it('normalizeCuil is normalizeCuit', () => {
    expect(normalizeCuil).toBe(normalizeCuit);
  });

  it('formatCuil is formatCuit', () => {
    expect(formatCuil).toBe(formatCuit);
  });
});

// ---------------------------------------------------------------------------
// CBU
// ---------------------------------------------------------------------------

describe('validateCBU', () => {
  // CBU válido de ejemplo: Banco Nación (011), sucursal 0599.
  // Dígitos verificadores calculados con los ponderadores oficiales BCRA
  // (bloque 1: 7139713 -> 5, bloque 2: 3971397139713 -> 1).
  const validCBU = '0110599500000041817221';

  it('validates a correct CBU', () => {
    expect(validateCBU(validCBU)).toBe(validCBU);
  });

  it('throws on wrong length', () => {
    expect(() => validateCBU('01105999400000418172')).toThrow(ArcaValidationError);
    expect(() => validateCBU('011059914000004181722199')).toThrow(ArcaValidationError);
  });

  it('throws on non-numeric', () => {
    expect(() => validateCBU('011059994000004181722a')).toThrow(ArcaValidationError);
  });

  it('throws on bad block 1 checksum', () => {
    // Block 1 verificador alterado (6 en vez de 5)
    expect(() => validateCBU('0110599600000041817221')).toThrow(/bloque 1/);
  });

  it('throws on bad block 2 checksum', () => {
    // Block 1 válido (01105995), block 2 último dígito alterado (2 en vez de 1)
    expect(() => validateCBU('0110599500000041817222')).toThrow(/bloque 2/);
  });
});

describe('isValidCBU', () => {
  it('returns true for valid CBU', () => {
    expect(isValidCBU('0110599500000041817221')).toBe(true);
  });

  it('returns false for invalid CBU', () => {
    expect(isValidCBU('1234567890123456789012')).toBe(false);
    expect(isValidCBU('short')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

describe('formatDate', () => {
  it('formats Date to YYYYMMDD', () => {
    // Usar UTC para evitar problemas de timezone en tests
    const result = formatDate(new Date('2026-03-15T12:00:00Z'));
    expect(result).toMatch(/^\d{8}$/);
    expect(result).toBe('20260315');
  });

  it('passes through YYYYMMDD string', () => {
    expect(formatDate('20260315')).toBe('20260315');
  });

  it('formatea YYYY-MM-DD literal, sin corrimiento de zona horaria', () => {
    expect(formatDate('2026-03-15')).toBe('20260315');
  });

  it('throws on invalid string', () => {
    expect(() => formatDate('not-a-date')).toThrow(ArcaValidationError);
  });
});

describe('parseAfipDate', () => {
  it('parses YYYYMMDD', () => {
    const date = parseAfipDate('20260315');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2); // March = 2
    expect(date.getDate()).toBe(15);
  });

  it('parses YYYY-MM-DD', () => {
    const date = parseAfipDate('2026-03-15');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);
  });

  it('throws on invalid format', () => {
    expect(() => parseAfipDate('15/03/2026')).toThrow(ArcaValidationError);
    expect(() => parseAfipDate('abc')).toThrow(ArcaValidationError);
  });
});

describe('validateFecha', () => {
  it('passes for valid Date', () => {
    expect(() => validateFecha(new Date(), 'test')).not.toThrow();
  });

  it('throws for invalid Date', () => {
    expect(() => validateFecha(new Date('invalid'), 'test')).toThrow(ArcaValidationError);
  });
});

describe('validateFechaRango', () => {
  it('passes when fin > inicio', () => {
    expect(() => validateFechaRango(
      new Date('2026-01-01'),
      new Date('2026-12-31'),
    )).not.toThrow();
  });

  it('passes when fin is undefined', () => {
    expect(() => validateFechaRango(new Date(), undefined)).not.toThrow();
  });

  it('throws when fin <= inicio', () => {
    expect(() => validateFechaRango(
      new Date('2026-06-01'),
      new Date('2026-01-01'),
    )).toThrow(ArcaValidationError);
  });

  it('throws when fin equals inicio', () => {
    const d = new Date('2026-06-01');
    expect(() => validateFechaRango(d, d)).toThrow(ArcaValidationError);
  });
});

// ---------------------------------------------------------------------------
// 0.4.0: fechas estrictas, formatCuit validado, collectErrors
// ---------------------------------------------------------------------------

import { collectErrors, collectErrorsWithPrefix } from '../src/index.js';
import type { ValidationErrorDetail } from '../src/index.js';

function withTZ(tz: string, fn: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('formatDate (estricto)', () => {
  it('rechaza fechas inexistentes', () => {
    for (const bad of ['20230230', '20231301', '00000000', '2023-02-29', '2024-00-10', '20240132']) {
      expect(() => formatDate(bad), bad).toThrow(ArcaValidationError);
    }
    expect(formatDate('20240229')).toBe('20240229');
  });

  it('rechaza formatos no estrictos', () => {
    for (const bad of ['2026-0315', '202603-15', '2026/03/15', ' 20260315', '2026-03-15T10:00:00Z', '']) {
      expect(() => formatDate(bad), bad).toThrow(ArcaValidationError);
    }
  });

  it('Date: usa la fecha calendario de Argentina', () => {
    // 02:30 UTC del 15 = 23:30 del 14 en Argentina.
    expect(formatDate(new Date('2026-03-15T02:30:00Z'))).toBe('20260314');
    expect(formatDate(new Date('2026-03-15T03:00:00Z'))).toBe('20260315');
  });

  it('Date: no depende de la zona horaria del proceso', () => {
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      withTZ(tz, () => {
        expect(formatDate(new Date('2026-03-15T02:30:00Z')), tz).toBe('20260314');
      });
    }
  });

  it('rechaza un Date inválido', () => {
    expect(() => formatDate(new Date('x'))).toThrow(ArcaValidationError);
  });
});

describe('parseAfipDate (estricto)', () => {
  it('rechaza guiones fuera de lugar y fechas inexistentes', () => {
    for (const bad of ['2026-0315', '20-26-03-15', '2026--03-15', '20230230', '2023-13-01', '00000000']) {
      expect(() => parseAfipDate(bad), bad).toThrow(ArcaValidationError);
    }
  });

  it('formatDate(parseAfipDate(x)) === x en cualquier zona horaria', () => {
    for (const tz of ['UTC', 'America/Argentina/Buenos_Aires', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      withTZ(tz, () => {
        for (const x of ['20260315', '20240229', '20261231', '20260101']) {
          expect(formatDate(parseAfipDate(x)), `${tz} ${x}`).toBe(x);
        }
        expect(formatDate(parseAfipDate('2026-03-15'))).toBe('20260315');
      });
    }
  });
});

describe('validateFecha / validateFechaRango (estricto)', () => {
  it('acepta strings válidos y rechaza inexistentes', () => {
    expect(() => validateFecha('20260315', 'f')).not.toThrow();
    expect(() => validateFecha('2026-03-15', 'f')).not.toThrow();
    const err = (() => {
      try {
        validateFecha('20230230', 'fechaX');
      } catch (e) {
        return e as ArcaValidationError;
      }
    })();
    expect(err).toBeInstanceOf(ArcaValidationError);
    expect(err?.field).toBe('fechaX');
  });

  it('valida el rango con strings', () => {
    expect(() => validateFechaRango('20260101', '20260102')).not.toThrow();
    expect(() => validateFechaRango('20260102', '20260101')).toThrow(ArcaValidationError);
    expect(() => validateFechaRango('20260101', '2026-02-30')).toThrow(ArcaValidationError);
  });
});

describe('formatCuit (validado)', () => {
  it('lanza si no son 11 dígitos', () => {
    expect(() => formatCuit('2012345678')).toThrow(ArcaValidationError);
    expect(() => formatCuit('20-12345678-6x')).toThrow(ArcaValidationError);
    expect(() => formatCuit(123)).toThrow(ArcaValidationError);
  });
});

describe('collectErrors', () => {
  it('recolecta ArcaValidationError', () => {
    const errors: ValidationErrorDetail[] = [];
    collectErrors(() => validateCuit('1'), errors);
    collectErrorsWithPrefix(() => validateCuit('1'), errors, 'emisor');
    expect(errors).toHaveLength(2);
    expect(errors[1].field).toBe('emisor.cuit');
  });

  it('re-lanza errores que no son de validación', () => {
    const errors: ValidationErrorDetail[] = [];
    const bug = () => {
      (undefined as unknown as { x: number }).x;
    };
    expect(() => collectErrors(bug, errors)).toThrow(TypeError);
    expect(() => collectErrorsWithPrefix(bug, errors, 'p')).toThrow(TypeError);
    expect(errors).toHaveLength(0);
  });
});
