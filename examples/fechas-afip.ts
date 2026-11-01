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

// Desde Date: fecha calendario en Argentina (America/Argentina/Buenos_Aires)
const hoy = formatDate(new Date());
console.log("Hoy:", hoy); // ej: "20260331"

// Desde YYYY-MM-DD: se formatea literal, sin pasar por Date (sin corrimientos de zona horaria)
const fecha1 = formatDate("2026-03-31");
console.log("Desde ISO:", fecha1); // "20260331"

// YYYYMMDD se devuelve tal cual (después de validar que la fecha exista)
const fecha2 = formatDate("20260331");
console.log("Passthrough:", fecha2); // "20260331"

// Útil para armar requests a ARCA:
const request = {
  CbteFch: formatDate(new Date()),           // fecha del comprobante
  FchServDesde: formatDate("2026-03-01"),     // inicio del servicio
  FchServHasta: formatDate("2026-03-31"),     // fin del servicio
  FchVtoPago: formatDate("2026-04-15"),       // vencimiento de pago
  // Ojo: new Date("2026-04-15") es medianoche UTC = 14/04 21:00 en Argentina.
};
console.log("Request:", request);

// ---------------------------------------------------------------------------
// parseAfipDate — convertir YYYYMMDD a Date
// ---------------------------------------------------------------------------

// Fechas inexistentes o formatos ambiguos lanzan ArcaValidationError:
// formatDate("20230230"), formatDate("2026/03/31"), parseAfipDate("2026-0331")

// Parsear respuestas de ARCA (devuelve el mediodía de Argentina de ese día,
// así formatDate(parseAfipDate(x)) === x en cualquier zona horaria)
const fecha3 = parseAfipDate("20260331");
console.log("Parseado:", fecha3.toISOString()); // "2026-03-31T15:00:00.000Z"
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
