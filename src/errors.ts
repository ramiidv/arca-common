/**
 * Error base para todos los errores de los SDKs de ARCA.
 */
export class ArcaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArcaError';
  }
}

/**
 * Error de autenticación WSAA.
 * Se lanza cuando falla el login, el certificado es inválido, o la respuesta de WSAA es inesperada.
 */
export class ArcaAuthError extends ArcaError {
  constructor(message: string) {
    super(message);
    this.name = 'ArcaAuthError';
  }
}

/**
 * Error a nivel SOAP/HTTP.
 * Se lanza cuando el request HTTP falla, hay un timeout, o se recibe un SOAP Fault.
 */
export class ArcaSoapError extends ArcaError {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ArcaSoapError';
    this.statusCode = statusCode;
  }
}

/**
 * Error de servicio de ARCA (errores de negocio).
 * Se lanza cuando un web service responde con errores funcionales (ej: CUIT inválido, comprobante rechazado).
 * Contiene el array de errores con código y mensaje tal cual los devuelve ARCA.
 */
export class ArcaServiceError extends ArcaError {
  public readonly errors: { code: number; msg: string }[];

  constructor(message: string, errors: { code: number; msg: string }[]) {
    super(message);
    this.name = 'ArcaServiceError';
    this.errors = errors;
  }
}

/**
 * Error de validación de datos de entrada.
 * Se lanza cuando los datos proporcionados no cumplen con el formato esperado.
 */
export class ArcaValidationError extends ArcaError {
  public readonly field?: string;
  public readonly details: ValidationErrorDetail[];

  constructor(message: string, details: ValidationErrorDetail[], field?: string) {
    super(message);
    this.name = 'ArcaValidationError';
    this.details = details;
    this.field = field;
  }
}

export interface ValidationErrorDetail {
  field: string;
  message: string;
  value?: unknown;
}
