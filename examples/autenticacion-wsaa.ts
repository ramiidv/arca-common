/**
 * Ejemplo: Autenticación WSAA
 *
 * Muestra cómo obtener un Ticket de Acceso para cualquier
 * web service de ARCA usando el WsaaClient.
 */
import fs from "fs";
import { WsaaClient } from "@ramiidv/arca-common";

const wsaa = new WsaaClient({
  cert: fs.readFileSync("./cert.pem", "utf-8"),
  key: fs.readFileSync("./key.pem", "utf-8"),
  production: false,
  // Opcional:
  // timeout: 30_000,
  // retries: 2,
  // retryDelayMs: 1_000,
  // onEvent: (e) => console.log(e.type, e),
});

async function main() {
  // Obtener ticket para WSFE (facturación electrónica)
  const ticket = await wsaa.getAccessTicket("wsfe");
  console.log("Token:", ticket.token.slice(0, 40) + "...");
  console.log("Sign:", ticket.sign.slice(0, 40) + "...");
  console.log("Expira:", ticket.expirationTime.toISOString());

  // Segunda llamada — devuelve el ticket cacheado (no hace login de nuevo)
  const ticket2 = await wsaa.getAccessTicket("wsfe");
  console.log("¿Mismo ticket?", ticket.token === ticket2.token); // true

  // Obtener ticket para otro servicio (login independiente)
  const ticketPadron = await wsaa.getAccessTicket("ws_sr_padron_a13");
  console.log("Token padrón:", ticketPadron.token.slice(0, 40) + "...");

  // Invalidar cache si es necesario (ej: después de renovar certificado)
  wsaa.clearTicket("wsfe");
  wsaa.clearAllTickets();
}

main().catch(console.error);
