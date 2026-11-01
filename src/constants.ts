// ---------------------------------------------------------------------------
// WSAA
// ---------------------------------------------------------------------------

export const WSAA_ENDPOINTS = {
  testing: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  production: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
} as const;

export const WSAA_NAMESPACE = 'http://wsaa.view.sua.dvadac.desein.afip.gov';

// ---------------------------------------------------------------------------
// Tipos de Documento
// ---------------------------------------------------------------------------

/**
 * Tipos de documento del receptor. Valores de `FEParamGetTiposDoc` (WSFEv1).
 *
 * Fuente: ARCA, "Tablas del sistema" de Factura Electrónica, tabla
 * "Documento identificatorio del comprador"
 * (https://www.afip.gob.ar/fe/ayuda/tablas.asp →
 * https://www.afip.gob.ar/fe/documentos/TABLA%20DOC_ID%20COMPRADOR%20V.0%20%2025082010.xls).
 * No existe el código 15.
 */
export enum DocTipo {
  CI_POLICIA_FEDERAL = 0,
  CI_BUENOS_AIRES = 1,
  CI_CATAMARCA = 2,
  CI_CORDOBA = 3,
  CI_CORRIENTES = 4,
  CI_ENTRE_RIOS = 5,
  CI_JUJUY = 6,
  CI_MENDOZA = 7,
  CI_LA_RIOJA = 8,
  CI_SALTA = 9,
  CI_SAN_JUAN = 10,
  CI_SAN_LUIS = 11,
  CI_SANTA_FE = 12,
  CI_SANTIAGO_DEL_ESTERO = 13,
  CI_TUCUMAN = 14,
  CI_CHACO = 16,
  CI_CHUBUT = 17,
  CI_FORMOSA = 18,
  CI_MISIONES = 19,
  CI_NEUQUEN = 20,
  CI_LA_PAMPA = 21,
  CI_RIO_NEGRO = 22,
  CI_SANTA_CRUZ = 23,
  CI_TIERRA_DEL_FUEGO = 24,
  CERTIFICADO_MIGRACION = 30,
  CUIT = 80,
  CUIL = 86,
  CDI = 87,
  /** "Usado por Anses para Padrón" */
  ANSES_PADRON = 88,
  LE = 89,
  LC = 90,
  CI_EXTRANJERA = 91,
  EN_TRAMITE = 92,
  ACTA_NACIMIENTO = 93,
  PASAPORTE = 94,
  CI_BS_AS_RNP = 95,
  DNI = 96,
  /**
   * Alias de `CONSUMIDOR_FINAL`: la tabla oficial lo describe como "Sin
   * identificar/venta global diaria" y `FEParamGetTiposDoc` como "Doc. (Otro)".
   */
  SIN_IDENTIFICAR = 99,
  /** Consumidor final sin identificar (código 99, ver `SIN_IDENTIFICAR`). */
  CONSUMIDOR_FINAL = 99,
}

// ---------------------------------------------------------------------------
// Provincias
// ---------------------------------------------------------------------------

/**
 * Códigos de provincia de ARCA (SUPA), los que devuelven los servicios de
 * Padrón en `idProvincia`. No existe el código 15.
 *
 * Fuente: ARCA, "Tablas del sistema" de Factura Electrónica, tabla "Códigos de
 * Provincia" (https://www.afip.gob.ar/fe/ayuda/tablas.asp →
 * https://www.afip.gob.ar/fe/documentos/TABLA%20PROVINCIAS%20V.0%20%2025082010.xls).
 * Coincide con los ejemplos del manual de ws_sr_constancia_inscripcion y con
 * pyafipws (`padron.py`).
 */
export enum Provincia {
  CIUDAD_AUTONOMA_DE_BUENOS_AIRES = 0,
  BUENOS_AIRES = 1,
  CATAMARCA = 2,
  CORDOBA = 3,
  CORRIENTES = 4,
  ENTRE_RIOS = 5,
  JUJUY = 6,
  MENDOZA = 7,
  LA_RIOJA = 8,
  SALTA = 9,
  SAN_JUAN = 10,
  SAN_LUIS = 11,
  SANTA_FE = 12,
  SANTIAGO_DEL_ESTERO = 13,
  TUCUMAN = 14,
  CHACO = 16,
  CHUBUT = 17,
  FORMOSA = 18,
  MISIONES = 19,
  NEUQUEN = 20,
  LA_PAMPA = 21,
  RIO_NEGRO = 22,
  SANTA_CRUZ = 23,
  TIERRA_DEL_FUEGO = 24,
}

// ---------------------------------------------------------------------------
// Condición frente al IVA (receptor / emisor)
// ---------------------------------------------------------------------------

/**
 * Condición frente al IVA. Valores de `FEParamGetCondicionIvaReceptor` (WSFEv1),
 * usados en el campo `CondicionIVAReceptorId`.
 */
export enum CondicionIva {
  RESPONSABLE_INSCRIPTO = 1,
  EXENTO = 4,
  CONSUMIDOR_FINAL = 5,
  /** Responsable Monotributo */
  MONOTRIBUTISTA = 6,
  NO_CATEGORIZADO = 7,
  PROVEEDOR_EXTERIOR = 8,
  CLIENTE_EXTERIOR = 9,
  /** IVA Liberado – Ley N° 19.640 */
  IVA_LIBERADO = 10,
  MONOTRIBUTO_SOCIAL = 13,
  IVA_NO_ALCANZADO = 15,
  MONOTRIBUTO_INDEPENDIENTE_PROMOVIDO = 16,
}
