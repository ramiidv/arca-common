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

export enum DocTipo {
  CUIT = 80,
  CUIL = 86,
  CDI = 87,
  LE = 89,
  LC = 90,
  CI_EXTRANJERA = 91,
  EN_TRAMITE = 92,
  ACTA_NACIMIENTO = 93,
  PASAPORTE = 94,
  CI_BS_AS_RNP = 95,
  DNI = 96,
  CONSUMIDOR_FINAL = 99,
}

// ---------------------------------------------------------------------------
// Provincias
// ---------------------------------------------------------------------------

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
  CHACO = 15,
  CHUBUT = 16,
  FORMOSA = 17,
  MISIONES = 18,
  NEUQUEN = 19,
  LA_PAMPA = 20,
  RIO_NEGRO = 21,
  SANTA_CRUZ = 22,
  TIERRA_DEL_FUEGO = 23,
}
