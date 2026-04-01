/**
 * Ejemplo: Validación de CUIT y CBU
 *
 * Muestra las distintas formas de validar, normalizar y
 * formatear CUITs/CUILs y CBUs.
 */
import {
  validateCuit,
  isValidCuit,
  normalizeCuit,
  formatCuit,
  validateCBU,
  isValidCBU,
  ArcaValidationError,
} from "@ramiidv/arca-common";

// ---------------------------------------------------------------------------
// CUIT — validación estricta (lanza error si es inválido)
// ---------------------------------------------------------------------------

// Acepta string con guiones
const cuit1 = validateCuit("20-12345678-6");
console.log("CUIT validado:", cuit1); // "20123456786"

// Acepta string sin guiones
const cuit2 = validateCuit("20123456786");
console.log("CUIT validado:", cuit2); // "20123456786"

// Acepta number (ARCA devuelve CUITs como number en muchas respuestas)
const cuit3 = validateCuit(20123456786);
console.log("CUIT validado:", cuit3); // "20123456786"

// ---------------------------------------------------------------------------
// CUIT — check booleano (no lanza error)
// ---------------------------------------------------------------------------

const cuitCliente = "20123456786";

if (isValidCuit(cuitCliente)) {
  console.log("CUIT válido, procesando...");
} else {
  console.log("CUIT inválido, rechazando...");
}

// También acepta number
console.log(isValidCuit(20123456786)); // true
console.log(isValidCuit(12345));       // false
console.log(isValidCuit("INVALIDO"));  // false

// ---------------------------------------------------------------------------
// CUIT — normalizar y formatear
// ---------------------------------------------------------------------------

// Normalizar: quitar guiones, convertir number a string
console.log(normalizeCuit("20-12345678-6")); // "20123456786"
console.log(normalizeCuit(20123456786));     // "20123456786"

// Formatear: agregar guiones
console.log(formatCuit("20123456786")); // "20-12345678-6"
console.log(formatCuit(20123456786));   // "20-12345678-6"

// ---------------------------------------------------------------------------
// CUIT — capturar errores de validación
// ---------------------------------------------------------------------------

try {
  validateCuit("20-11111111-1");
} catch (e) {
  if (e instanceof ArcaValidationError) {
    console.log("Campo:", e.field);        // "cuit"
    console.log("Mensaje:", e.message);    // "CUIT inválido: ..."
    console.log("Detalles:", e.details);   // [{ field, message, value }]
  }
}

// ---------------------------------------------------------------------------
// CBU — validación
// ---------------------------------------------------------------------------

const cbu = validateCBU("0110599140000041817221");
console.log("CBU validado:", cbu);

// Check booleano
console.log(isValidCBU("0110599140000041817221")); // true
console.log(isValidCBU("1234567890123456789012")); // false

// Error detallado
try {
  validateCBU("0000000000000000000000");
} catch (e) {
  if (e instanceof ArcaValidationError) {
    console.log("Error CBU:", e.details[0].message);
  }
}
