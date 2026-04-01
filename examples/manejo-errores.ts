/**
 * Ejemplo: Manejo de errores
 *
 * El SDK provee una jerarquía de errores específicos para
 * distinguir entre problemas de autenticación, SOAP, negocio
 * y validación de datos.
 */
import fs from "fs";
import {
  WsaaClient,
  ArcaError,
  ArcaAuthError,
  ArcaSoapError,
  ArcaServiceError,
  ArcaValidationError,
  validateCuit,
} from "@ramiidv/arca-common";

// ---------------------------------------------------------------------------
// Error de validación — datos de entrada inválidos
// ---------------------------------------------------------------------------

try {
  validateCuit("INVALIDO");
} catch (e) {
  if (e instanceof ArcaValidationError) {
    console.log("=== Error de validación ===");
    console.log("Mensaje:", e.message);
    console.log("Campo:", e.field);
    console.log("Detalles:");
    for (const detail of e.details) {
      console.log(`  ${detail.field}: ${detail.message} (valor: ${detail.value})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Errores de WSAA y SOAP — autenticación y transporte
// ---------------------------------------------------------------------------

async function ejemploErroresWsaa() {
  const wsaa = new WsaaClient({
    cert: fs.readFileSync("./cert.pem", "utf-8"),
    key: fs.readFileSync("./key.pem", "utf-8"),
    production: false,
  });

  try {
    await wsaa.getAccessTicket("wsfe");
  } catch (e) {
    if (e instanceof ArcaAuthError) {
      // Certificado inválido, expirado, no autorizado para el servicio, etc.
      console.log("=== Error de autenticación ===");
      console.log("Mensaje:", e.message);
      wsaa.clearAllTickets(); // limpiar cache por si el token estaba corrupto
    }

    if (e instanceof ArcaSoapError) {
      // Timeout, HTTP 5xx, SOAP Fault, red caída
      console.log("=== Error de transporte ===");
      console.log("Mensaje:", e.message);
      console.log("HTTP status:", e.statusCode); // undefined si fue timeout/red
    }

    if (e instanceof ArcaServiceError) {
      // Error funcional de ARCA (códigos de error del web service)
      console.log("=== Error de servicio ===");
      for (const err of e.errors) {
        console.log(`  [${err.code}] ${err.msg}`);
      }
    }

    // Catch-all: todos extienden ArcaError
    if (e instanceof ArcaError) {
      console.log("Algún error de ARCA:", e.message);
    }
  }
}

ejemploErroresWsaa().catch(console.error);
