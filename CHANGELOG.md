# Changelog

## 0.1.0 (2026-03-31)

### Features
- Initial release
- WSAA authentication client with token caching and request deduplication
- Generic SOAP client with retry, timeout, and exponential backoff
- XML parsing/building utilities (via fast-xml-parser)
- Error hierarchy: ArcaError, ArcaAuthError, ArcaSoapError, ArcaServiceError, ArcaValidationError
- CUIL/CUIT validation with checksum verification
- CBU validation (22-digit format with block checksums)
- Date validation utilities
- Shared types: AccessTicket, ArcaBaseConfig, SoapCallOptions, ServerStatus, ArcaEvent
- Shared constants: WSAA endpoints, DocTipo enum, Provincia enum
