/**
 * Ejemplo: Manejo de fechas en formato AFIP
 *
 * AFIP/ARCA usa el formato YYYYMMDD en la mayoría de sus web services.
 * Estas utilidades facilitan la conversión entre Date de JS y ese formato.
 */
import { formatDate, parseAfipDate } from "@ramiidv/arca-common";

// ---------------------------------------------------------------------------
// formatDate — convertir a YYYYMMDD
// ---------------------------------------------------------------------------

// Desde Date (usa timezone Argentina UTC-3)
const hoy = formatDate(new Date());
console.log("Hoy:", hoy); // ej: "20260331"

// Desde string ISO
const fecha1 = formatDate("2026-03-31");
console.log("Desde ISO:", fecha1); // "20260331"

// Passthrough si ya es YYYYMMDD
const fecha2 = formatDate("20260331");
console.log("Passthrough:", fecha2); // "20260331"

// Útil para armar requests a ARCA:
const request = {
  CbteFch: formatDate(new Date()),           // fecha del comprobante
  FchServDesde: formatDate("2026-03-01"),     // inicio del servicio
  FchServHasta: formatDate("2026-03-31"),     // fin del servicio
  FchVtoPago: formatDate(new Date("2026-04-15")), // vencimiento de pago
};
console.log("Request:", request);

// ---------------------------------------------------------------------------
// parseAfipDate — convertir YYYYMMDD a Date
// ---------------------------------------------------------------------------

// Parsear respuestas de ARCA
const fecha3 = parseAfipDate("20260331");
console.log("Parseado:", fecha3.toISOString()); // "2026-03-31T03:00:00.000Z" (aprox)
console.log("Año:", fecha3.getFullYear());      // 2026
console.log("Mes:", fecha3.getMonth() + 1);     // 3 (marzo)
console.log("Día:", fecha3.getDate());           // 31

// También acepta YYYY-MM-DD (algunos servicios Java de ARCA usan este formato)
const fecha4 = parseAfipDate("2026-03-31");
console.log("Desde YYYY-MM-DD:", fecha4.toISOString());

// Ejemplo: parsear fecha de vencimiento de CAE
const caeVencimiento = "20260415"; // viene de la respuesta de ARCA
const vtoDate = parseAfipDate(caeVencimiento);
const diasRestantes = Math.ceil((vtoDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
console.log(`CAE vence el ${formatDate(vtoDate)}, quedan ${diasRestantes} días`);
