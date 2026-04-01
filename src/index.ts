// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export {
  ArcaError,
  ArcaAuthError,
  ArcaSoapError,
  ArcaServiceError,
  ArcaValidationError,
} from './errors.js';
export type { ValidationErrorDetail } from './errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type {
  AccessTicket,
  ArcaBaseConfig,
  SoapCallOptions,
  ServerStatus,
  ArcaEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// WSAA
// ---------------------------------------------------------------------------
export { WsaaClient } from './wsaa.js';
export type { WsaaClientConfig } from './wsaa.js';

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
  checkServiceErrors,
} from './soap-client.js';

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------
export {
  validateCuil,
  validateCBU,
  normalizeCuil,
  formatCuil,
  validateFecha,
  validateFechaRango,
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
} from './constants.js';
