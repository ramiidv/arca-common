# Changelog

## 0.3.0 (2026-10-30)

### Breaking changes
- `AccessTicket.expirationTime` es un string ISO-8601 (antes `Date`), para que el ticket sea
  serializable a JSON. Se agregan `generationTime?` y `service?`.
- `WsaaClient.clearTicket` y `clearAllTickets` devuelven `Promise<void>` (también borran del storage).
- `soapCall` devuelve la respuesta parseada **sin prefijos de namespace** (`Envelope` en lugar de
  `soap:Envelope`). `afipSoapCall` no cambia su contrato.
- `soapCall` solo reintenta consultas: los SOAP Faults (aunque lleguen con HTTP 500) ya no se reintentan.

### Features
- `ticketStorage` en `WsaaClient`: persistencia de Tickets de Acceso entre reinicios. Orden de
  lectura memoria → storage → login; key `entorno:huellaDelCert:servicio`.
- `MemoryTicketStorage` y `FileTicketStorage` como implementaciones de referencia.
- `ArcaTicketVigenteError`: WSAA indica que ya hay un TA vigente y no está en el storage.
- `clockOffsetMs` y `autoClockSkew` (default `true`): ajuste del reloj desde el header `Date` de WSAA,
  con evento `auth:clock-skew`. `wsaa.now()` y `wsaa.clockOffsetMs` exponen el reloj de ARCA.
- `soapCall` acepta `kind: "consulta" | "emision"` (las emisiones nunca se reintentan) y `signal`.
- `ArcaSoapError` expone `faultCode`, `faultString`, `responseDate`, `uncertain` y `aborted`.
- Todos los errores tienen un `code` estable, y `instanceof` funciona entre copias del paquete.
- `CondicionIva` (movido desde arca-facturacion) y `extractMethodResult`.
- Eventos `auth:clock-skew` y `auth:storage-error`; `auth:cache-hit` indica `source`.
- Build dual ESM + CommonJS con `exports` condicional, y smoke test CommonJS/ESM en CI.

### Fixes
- Los SOAP Faults con HTTP 500 (como los de WSAA) se perdían: el error solo decía `HTTP 500`.
- `afipSoapCall` no desenvolvía `personaReturn` (Padrón) ni respuestas con prefijo de namespace.

## 0.1.0 (2026-03-31)

### Features
- Initial release
- WSAA authentication client with token caching and request deduplication
- Generic SOAP client with retry, timeout, and exponential backoff
- XML parsing/building utilities (via fast-xml-parser)
- Error hierarchy: ArcaError, ArcaAuthError, ArcaSoapError, ArcaServiceError, ArcaValidationError
- CUIT/CUIL validation with Módulo 11 checksum verification (accepts string and number)
- `isValidCuit()` — non-throwing boolean check
- CBU validation (22-digit format with block checksums)
- `isValidCBU()` — non-throwing boolean check
- `formatDate()` — formats Date/string to YYYYMMDD (AFIP format, timezone Argentina)
- `parseAfipDate()` — parses YYYYMMDD or YYYY-MM-DD to Date
- Date range validation utilities
- Shared types: AccessTicket, ArcaBaseConfig, SoapCallOptions, ServerStatus, ArcaEvent
- Shared constants: WSAA endpoints, DocTipo enum, Provincia enum
- Backward-compatible aliases: `validateCuil`, `normalizeCuil`, `formatCuil` → apuntan a `validateCuit`, `normalizeCuit`, `formatCuit`
