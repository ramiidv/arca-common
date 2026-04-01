# @ramiidv/arca-common

[![npm](https://img.shields.io/npm/v/@ramiidv/arca-common)](https://www.npmjs.com/package/@ramiidv/arca-common)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Utilidades compartidas para el ecosistema de SDKs de **ARCA** (ex AFIP) en TypeScript.

Este paquete es la base sobre la que se construyen los SDKs de dominio:

- [`@ramiidv/arca-facturacion`](https://github.com/ramiidv/arca-facturacion) — Facturacion electronica (WSFEv1, WSFEX, CAEA)
- [`@ramiidv/arca-padron`](https://github.com/ramiidv/arca-padron) — Consulta de contribuyentes (Padron A4, A10, A100)
- [`@ramiidv/arca-empleados`](https://github.com/ramiidv/arca-empleados) — Gestion de empleados (F935)
- [`@ramiidv/arca-cdc`](https://github.com/ramiidv/arca-cdc) — Constatacion de comprobantes (WSCDC)
- [`@ramiidv/arca-fecred`](https://github.com/ramiidv/arca-fecred) — Factura de Credito Electronica MiPyME (WSFECRED)
- [`@ramiidv/arca-sire`](https://github.com/ramiidv/arca-sire) — Retenciones electronicas (SIRE)
- [`@ramiidv/arca-agro`](https://github.com/ramiidv/arca-agro) — Carta de porte, CTG y liquidaciones de granos (WSCPE, WSCTG, WSLPG)
- [`@ramiidv/arca-mtxca`](https://github.com/ramiidv/arca-mtxca) — Facturacion con detalle de articulos (WSMTXCA)

## Instalacion

```bash
npm install @ramiidv/arca-common
```

## Requisitos

- Node.js >= 18
- Certificado digital X.509 y clave privada de ARCA
  - **Testing**: generalo desde [WSASS Homologacion](https://wsass-homo.afip.gob.ar/wsass/portal/main.aspx)
  - **Produccion**: generalo desde [Administracion de Certificados Digitales](https://www.afip.gob.ar/ws/documentacion/certificados.asp) (requiere clave fiscal en [arca.gob.ar](https://arca.gob.ar))

## Que incluye

| Modulo | Descripcion |
| --- | --- |
| **WsaaClient** | Cliente WSAA con firma CMS/PKCS#7, cache de tokens y deduplicacion de requests |
| **SOAP client** | `soapCall`, `afipSoapCall`, `checkServiceErrors` — llamadas SOAP con retry, timeout y backoff exponencial |
| **XML utilities** | `parseXml`, `buildXml`, `ensureArray`, `getNestedValue` — via fast-xml-parser |
| **Validators** | `validateCuit`, `isValidCuit`, `validateCBU`, `isValidCBU`, `formatDate`, `parseAfipDate`, `validateFecha`, `validateFechaRango` |
| **Errors** | Jerarquia de errores: `ArcaError`, `ArcaAuthError`, `ArcaSoapError`, `ArcaServiceError`, `ArcaValidationError` |
| **Types** | `AccessTicket`, `ArcaBaseConfig`, `SoapCallOptions`, `ServerStatus`, `ArcaEvent` |
| **Constants** | `WSAA_ENDPOINTS`, `DocTipo`, `Provincia` |

## Uso

### WsaaClient — Autenticacion WSAA

```typescript
import fs from "fs";
import { WsaaClient } from "@ramiidv/arca-common";

const wsaa = new WsaaClient({
  cert: fs.readFileSync("./cert.crt", "utf-8"),
  key: fs.readFileSync("./key.key", "utf-8"),
  production: false,
});

// Obtener ticket de acceso para un servicio
const ticket = await wsaa.getAccessTicket("wsfe");
console.log(ticket.token);
console.log(ticket.sign);
console.log(ticket.expirationTime);

// El ticket se cachea automaticamente. Llamadas subsiguientes
// devuelven el ticket cacheado si no expiro.
const ticket2 = await wsaa.getAccessTicket("wsfe"); // cache hit

// Invalidar cache manualmente
wsaa.clearTicket("wsfe");
wsaa.clearAllTickets();
```

### Validacion de CUIT/CUIL

```typescript
import { validateCuit, normalizeCuit, formatCuit, isValidCuit } from "@ramiidv/arca-common";

// Valida formato y digito verificador, retorna 11 digitos
const cuit = validateCuit("20-12345678-6"); // "20123456786"
const cuit2 = validateCuit(20123456786);    // "20123456786" (acepta number)

// Check sin lanzar error
if (isValidCuit(cuitDelCliente)) {
  // procesar...
}

// Normalizar (quitar guiones, acepta number)
normalizeCuit("20-12345678-6"); // "20123456786"
normalizeCuit(20123456786);     // "20123456786"

// Formatear
formatCuit("20123456786"); // "20-12345678-6"
formatCuit(20123456786);   // "20-12345678-6"

// Lanza ArcaValidationError si es invalido
try {
  validateCuit("00000000000");
} catch (e) {
  console.error(e.message);  // "CUIT invalido: ..."
  console.error(e.details);  // [{ field: "cuit", message: "...", value: "..." }]
}
```

### Validacion de CBU

```typescript
import { validateCBU, isValidCBU } from "@ramiidv/arca-common";

// Valida formato de 22 digitos y checksums de ambos bloques
const cbu = validateCBU("0110599140000041817221");

// Check sin lanzar error
if (isValidCBU(cbuDelCliente)) {
  // procesar...
}
```

### Fechas (formato AFIP)

```typescript
import { formatDate, parseAfipDate } from "@ramiidv/arca-common";

// Formatear a YYYYMMDD (formato AFIP, timezone Argentina)
formatDate(new Date());          // "20260331"
formatDate("20260331");          // "20260331" (passthrough)
formatDate("2026-03-31");        // "20260331" (parsea ISO)

// Parsear YYYYMMDD a Date
const fecha = parseAfipDate("20260331"); // Date(2026, 2, 31)
parseAfipDate("2026-03-31");             // tambien acepta guiones
```

### SOAP client

```typescript
import { soapCall, afipSoapCall, checkServiceErrors, parseXml, buildXml } from "@ramiidv/arca-common";

// Llamada SOAP de bajo nivel
const result = await soapCall("https://wswhomo.afip.gov.ar/wsfev1/service.asmx", bodyXml, {
  timeout: 30_000,
  retries: 2,
  retryDelayMs: 1_000,
  soapAction: "",
});

// Llamada SOAP de alto nivel (construye envelope, extrae resultado)
const data = await afipSoapCall(
  "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  "http://ar.gov.afip.dif.FEV1/",
  "FEDummy",
  {},
);

// Verificar errores de negocio en la respuesta
checkServiceErrors(data, "WSFE");

// Utilidades XML
const obj = parseXml("<root><item>1</item></root>");
const xml = buildXml({ root: { item: 1 } });
```

### Manejo de errores

```typescript
import {
  ArcaError,
  ArcaAuthError,
  ArcaSoapError,
  ArcaServiceError,
  ArcaValidationError,
} from "@ramiidv/arca-common";

try {
  const ticket = await wsaa.getAccessTicket("wsfe");
} catch (e) {
  if (e instanceof ArcaAuthError) {
    // Login WSAA fallo (certificado invalido, expirado, etc.)
    console.error("Auth error:", e.message);
  }

  if (e instanceof ArcaSoapError) {
    // Error HTTP/SOAP (timeout, 5xx, SOAP Fault)
    console.error("HTTP status:", e.statusCode);
  }

  if (e instanceof ArcaServiceError) {
    // Error de negocio de ARCA (CUIT invalido, comprobante rechazado, etc.)
    for (const err of e.errors) {
      console.error(`[${err.code}] ${err.msg}`);
    }
  }

  if (e instanceof ArcaValidationError) {
    // Error de validacion de datos de entrada
    console.error("Campo:", e.field);
    for (const detail of e.details) {
      console.error(`  ${detail.field}: ${detail.message}`);
    }
  }

  // Todos extienden ArcaError
  if (e instanceof ArcaError) {
    console.error("ARCA error:", e.message);
  }
}
```

### Constantes

```typescript
import { WSAA_ENDPOINTS, DocTipo, Provincia } from "@ramiidv/arca-common";

// Endpoints WSAA
console.log(WSAA_ENDPOINTS.testing);    // "https://wsaahomo.afip.gov.ar/ws/services/LoginCms"
console.log(WSAA_ENDPOINTS.production); // "https://wsaa.afip.gov.ar/ws/services/LoginCms"

// Tipos de documento
console.log(DocTipo.CUIT); // 80
console.log(DocTipo.DNI);  // 96

// Provincias
console.log(Provincia.BUENOS_AIRES); // 1
console.log(Provincia.CORDOBA);      // 3
```

## API

### `new WsaaClient(config)`

| Parametro | Tipo | Default | Descripcion |
| --- | --- | --- | --- |
| `cert` | `string` | -- | Certificado X.509 en formato PEM |
| `key` | `string` | -- | Clave privada RSA en formato PEM |
| `production` | `boolean` | `false` | Usar entorno de produccion |
| `endpoint` | `string` | -- | URL custom del endpoint WSAA (ignora `production`) |
| `tokenTTLMinutes` | `number` | `720` | Tiempo de vida del token en minutos (12 horas) |
| `timeout` | `number` | `30000` | Timeout HTTP en milisegundos |
| `retries` | `number` | `1` | Reintentos en errores transitorios |
| `retryDelayMs` | `number` | `1000` | Delay base para backoff exponencial |
| `onEvent` | `function` | -- | Callback para eventos del SDK |

### Metodos de WsaaClient

| Metodo | Retorno | Descripcion |
| --- | --- | --- |
| `getAccessTicket(service)` | `Promise<AccessTicket>` | Obtiene un ticket de acceso (con cache y dedup) |
| `clearTicket(service)` | `void` | Invalida el ticket cacheado para un servicio |
| `clearAllTickets()` | `void` | Invalida todos los tickets cacheados |

### SOAP client

| Funcion | Descripcion |
| --- | --- |
| `soapCall(endpoint, bodyContent, opts?)` | Llamada SOAP de bajo nivel con retry y timeout |
| `afipSoapCall(endpoint, namespace, method, params, opts?)` | Llamada SOAP de alto nivel para WS de ARCA |
| `checkServiceErrors(result, serviceName)` | Lanza `ArcaServiceError` si hay errores de negocio |
| `parseXml(xml)` | Parsea XML a objeto JS |
| `buildXml(obj)` | Construye XML desde objeto JS |
| `ensureArray(val)` | Normaliza valor/array/null a array |
| `getNestedValue(obj, ...keys)` | Busca valor probando multiples keys (para namespaces SOAP) |

### Validators

| Funcion | Retorno | Descripcion |
| --- | --- | --- |
| `validateCuit(cuit)` | `string` | Valida CUIT/CUIL (formato + checksum), retorna 11 digitos. Acepta `string \| number` |
| `isValidCuit(cuit)` | `boolean` | Verifica si un CUIT es valido sin lanzar error |
| `normalizeCuit(cuit)` | `string` | Elimina guiones, acepta `string \| number` |
| `formatCuit(cuit)` | `string` | Formatea como XX-XXXXXXXX-X, acepta `string \| number` |
| `validateCBU(cbu)` | `string` | Valida CBU (22 digitos + checksums de bloques) |
| `isValidCBU(cbu)` | `boolean` | Verifica si un CBU es valido sin lanzar error |
| `formatDate(date)` | `string` | Formatea `Date \| string` a YYYYMMDD (timezone Argentina) |
| `parseAfipDate(str)` | `Date` | Parsea YYYYMMDD o YYYY-MM-DD a Date |
| `validateFecha(date, fieldName)` | `void` | Valida que sea un Date valido |
| `validateFechaRango(inicio, fin)` | `void` | Valida que fin sea posterior a inicio |
| `collectErrors(fn, errors)` | `void` | Ejecuta validacion y recolecta errores sin lanzar |
| `collectErrorsWithPrefix(fn, errors, prefix)` | `void` | Como `collectErrors` pero prefija el campo |

### Errores

| Clase | Cuando se lanza | Propiedades extra |
| --- | --- | --- |
| `ArcaError` | Clase base para todos los errores | -- |
| `ArcaAuthError` | Login WSAA fallo, certificado invalido, respuesta inesperada | -- |
| `ArcaSoapError` | Error HTTP, timeout, SOAP Fault | `statusCode?: number` |
| `ArcaServiceError` | Error de negocio de ARCA (codigos funcionales) | `errors: { code, msg }[]` |
| `ArcaValidationError` | Datos de entrada invalidos | `field?: string`, `details: ValidationErrorDetail[]` |

### Types

| Tipo | Descripcion |
| --- | --- |
| `AccessTicket` | Token + sign + expirationTime |
| `ArcaBaseConfig` | Config base: cert, key, production, timeout, retries, onEvent |
| `SoapCallOptions` | Opciones para llamadas SOAP: timeout, retries, soapAction, onEvent |
| `ServerStatus` | Estado de servidores: appserver, dbserver, authserver |
| `ArcaEvent` | Union discriminada de eventos del SDK |
| `WsaaClientConfig` | Config del constructor de WsaaClient |
| `ValidationErrorDetail` | Detalle de error: field, message, value |

### Constants

| Constante | Tipo | Descripcion |
| --- | --- | --- |
| `WSAA_ENDPOINTS` | `{ testing, production }` | URLs de los endpoints WSAA |
| `WSAA_NAMESPACE` | `string` | Namespace XML del WSAA |
| `DocTipo` | `enum` | Tipos de documento (CUIT=80, CUIL=86, DNI=96, etc.) |
| `Provincia` | `enum` | Provincias argentinas (0-23) |

## Eventos

El SDK emite eventos via el callback `onEvent` para debugging y monitoreo.

| Evento | Cuando | Datos |
| --- | --- | --- |
| `auth:login` | Nuevo token obtenido | `service`, `durationMs` |
| `auth:cache-hit` | Token cacheado reutilizado | `service` |
| `request:start` | Antes de una llamada SOAP | `method`, `endpoint` |
| `request:end` | Llamada SOAP completada | `method`, `endpoint`, `durationMs` |
| `request:retry` | Reintentando tras error | `method`, `endpoint`, `attempt`, `error` |
| `request:error` | Llamada SOAP fallo | `method`, `endpoint`, `error` |

## Retry automatico

Habilitado por defecto (`retries: 1`). Solo reintenta en errores transitorios (timeout, HTTP 5xx, errores de red). No reintenta en errores de negocio. Backoff exponencial: `retryDelayMs * 2^attempt`.

```typescript
// Configurar retries
const wsaa = new WsaaClient({
  ...config,
  retries: 2,          // 2 reintentos (3 intentos totales)
  retryDelayMs: 2000,  // 2s, 4s
});
```

## Licencia

MIT
