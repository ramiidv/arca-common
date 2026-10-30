// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export {
  ArcaError,
  ArcaAuthError,
  ArcaSoapError,
  ArcaServiceError,
  ArcaValidationError,
  ArcaTicketVigenteError,
} from './errors.js';
export type { ValidationErrorDetail, ArcaSoapErrorOptions } from './errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type {
  AccessTicket,
  TicketStorage,
  ArcaBaseConfig,
  SoapCallOptions,
  SoapOperationKind,
  CallOptions,
  ServerStatus,
  ArcaEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// WSAA
// ---------------------------------------------------------------------------
export { WsaaClient } from './wsaa.js';
export type { WsaaClientConfig } from './wsaa.js';
export { MemoryTicketStorage, FileTicketStorage, normalizeAccessTicket } from './ticket-storage.js';
export { anySignal } from './signals.js';

// ---------------------------------------------------------------------------
// SOAP client
// ---------------------------------------------------------------------------
export {
  parseXml,
  buildXml,
  ensureArray,
  getNestedValue,
  soapCall,
  afipSoapCall,
  extractMethodResult,
  checkServiceErrors,
} from './soap-client.js';

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------
export {
  // CUIT/CUIL
  validateCuit,
  normalizeCuit,
  formatCuit,
  isValidCuit,
  // Aliases (backward compat)
  validateCuil,
  normalizeCuil,
  formatCuil,
  // CBU
  validateCBU,
  isValidCBU,
  // Fechas
  formatDate,
  parseAfipDate,
  validateFecha,
  validateFechaRango,
  // Helpers
  collectErrors,
  collectErrorsWithPrefix,
} from './validators.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export {
  WSAA_ENDPOINTS,
  WSAA_NAMESPACE,
  DocTipo,
  Provincia,
  CondicionIva,
} from './constants.js';
