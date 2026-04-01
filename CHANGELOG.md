# Changelog

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
