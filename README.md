# @ramiidv/arca-common

[![npm](https://img.shields.io/npm/v/@ramiidv/arca-common)](https://www.npmjs.com/package/@ramiidv/arca-common)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Utilidades compartidas para el ecosistema de SDKs de **ARCA** (ex AFIP) en TypeScript.

Este paquete es la base sobre la que se construyen los SDKs de dominio:

- [`@ramiidv/arca-facturacion`](https://github.com/ramiidv/arca-facturacion) — Facturacion electronica (WSFEv1, WSFEX, CAEA)
- [`@ramiidv/arca-padron`](https://github.com/ramiidv/arca-padron) — Consulta de contribuyentes (Constancia de Inscripcion, Padron A4, A10, A13, A100)
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

- Node.js >= 18. El paquete se publica en ESM y CommonJS: funciona con `import` y con `require` (incluido TypeScript con `"module": "CommonJS"`).
- Certificado digital X.509 y clave privada de ARCA
  - **Testing**: generalo desde [WSASS Homologacion](https://wsass-homo.afip.gob.ar/wsass/portal/main.aspx)
  - **Produccion**: generalo desde [Administracion de Certificados Digitales](https://www.afip.gob.ar/ws/documentacion/certificados.asp) (requiere clave fiscal en [arca.gob.ar](https://arca.gob.ar))

## Que incluye

| Modulo | Descripcion |
| --- | --- |
| **WsaaClient** | Cliente WSAA con firma CMS/PKCS#7, cache de tokens, persistencia (`ticketStorage`), deduplicacion y ajuste de reloj |
| **Ticket storage** | `MemoryTicketStorage`, `FileTicketStorage` — implementaciones de referencia de `TicketStorage` |
| **SOAP client** | `soapCall`, `afipSoapCall`, `checkServiceErrors`, `extractServiceErrors` — llamadas SOAP con timeout, `signal`, retry solo en consultas, deteccion de resultados inciertos y fallback TLS para hosts con DH de 1024 bits |
| **XML utilities** | `parseXml`, `buildXml`, `ensureArray`, `getNestedValue` — via fast-xml-parser |
| **Validators** | `validateCuit`, `isValidCuit`, `validateCBU`, `isValidCBU`, `formatDate`, `parseAfipDate`, `validateFecha`, `validateFechaRango` |
| **Errors** | Jerarquia de errores: `ArcaError`, `ArcaAuthError`, `ArcaTicketVigenteError`, `ArcaSoapError`, `ArcaServiceError`, `ArcaValidationError` |
| **Types** | `AccessTicket`, `TicketStorage`, `ArcaBaseConfig`, `SoapCallOptions`, `AfipSoapCallOptions`, `LegacyTlsMode`, `CallOptions`, `ServerStatus`, `ArcaEvent` |
| **Constants** | `WSAA_ENDPOINTS`, `DocTipo`, `Provincia`, `CondicionIva` |

## Uso

### WsaaClient — Autenticacion WSAA

```typescript
import fs from "fs";
import { WsaaClient, FileTicketStorage } from "@ramiidv/arca-common";

const wsaa = new WsaaClient({
  cert: fs.readFileSync("./cert.crt", "utf-8"),
  key: fs.readFileSync("./key.key", "utf-8"),
  production: false,
  ticketStorage: new FileTicketStorage("./.arca-tickets"), // recomendado
});

// Obtener ticket de acceso para un servicio
const ticket = await wsaa.getAccessTicket("wsfe");
console.log(ticket.token);
console.log(ticket.sign);
console.log(ticket.expirationTime); // "2026-10-30T23:00:00.000Z" (ISO, serializable)

// El ticket se cachea automaticamente. Llamadas subsiguientes
// devuelven el ticket cacheado si no expiro.
const ticket2 = await wsaa.getAccessTicket("wsfe"); // cache hit

// Invalidar (memoria y storage)
await wsaa.clearTicket("wsfe");
await wsaa.clearAllTickets();
```

### Persistencia del Ticket de Acceso

WSAA **rechaza el login si ya existe un TA vigente** para el mismo certificado y servicio
("El CEE ya posee un TA valido"). Si tu proceso se reinicia y el TA solo estaba en memoria,
no vas a poder loguearte hasta que venza (hasta 12 horas). Para evitarlo, configura un
`ticketStorage`:

- Orden de lectura: memoria → storage → login. Despues de un login exitoso, se persiste.
- `clearTicket` tambien borra del storage. **Ojo:** WSAA no emite un ticket nuevo mientras el
  anterior siga vigente, asi que borrar uno vigente te deja sin acceso hasta que venza. Usalo solo
  si el ticket es invalido (por ejemplo, cambiaste de certificado).
- En los 2 minutos previos al vencimiento el SDK intenta renovar; si WSAA todavia no lo permite,
  sigue usando el ticket actual hasta su vencimiento real.
- Los logins concurrentes se deduplican (incluida la lectura del storage).
- Si WSAA responde "ya posee un TA valido" y el storage no tiene el ticket (despues de
  releerlo, por si otro proceso lo acaba de guardar), se lanza `ArcaTicketVigenteError`.
- Si el storage falla, el SDK sigue funcionando con el ticket en memoria y emite `auth:storage-error`.

La key que recibe el storage identifica entorno, certificado y servicio
(`"prod:3f9a0c1b2d4e5f60:wsfe"`), asi que el mismo storage sirve para varios CUITs y entornos.
`AccessTicket` es JSON puro (fechas ISO-8601), asi que se guarda tal cual:

```typescript
import type { TicketStorage, AccessTicket } from "@ramiidv/arca-common";

// Ejemplo sobre una tabla key/value (Postgres, SQLite, Redis, etc.)
const dbStorage: TicketStorage = {
  async get(key) {
    const row = await db.query("SELECT value FROM arca_tickets WHERE key = $1", [key]);
    return row ? (JSON.parse(row.value) as AccessTicket) : null;
  },
  async set(key, ticket) {
    await db.query(
      "INSERT INTO arca_tickets (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [key, JSON.stringify(ticket)],
    );
  },
  async delete(key) {
    await db.query("DELETE FROM arca_tickets WHERE key = $1", [key]);
  },
};
```

> El token y el sign dan acceso a los web services de ARCA con tu CUIT: guardalos como un secreto.

> Si un login llega a WSAA pero la respuesta se pierde (timeout), ese TA no se puede recuperar:
> el siguiente login falla con `ArcaTicketVigenteError` hasta que venza. Por eso el SDK nunca
> aborta un login en curso, aunque el caller cancele su `signal`.

### Reloj desfasado

WSAA rechaza el TRA si el reloj local esta muy corrido. Con `autoClockSkew: true` (default), ante
ese rechazo el SDK calcula el offset desde el header `Date` de la respuesta, reintenta el login
una sola vez y emite `auth:clock-skew`. Tambien se puede fijar a mano con `clockOffsetMs`
(`relojARCA - relojLocal`, en ms). `wsaa.clockOffsetMs` y `wsaa.now()` exponen el offset vigente.

Solo se consideran errores de reloj `xml.generationTime.invalid` y `xml.expirationTime.expired`.
`xml.expirationTime.invalid` (vigencia pedida mayor a 24 horas) es un error de configuracion de
`tokenTTLMinutes` y no dispara el ajuste.

### Login fallido

La especificacion de WSAA pide no reintentar un login rechazado enseguida. Si un login falla (por
ejemplo, certificado no autorizado), durante `loginErrorCooldownMs` (default `60000`, `0` lo
desactiva) `getAccessTicket` para ese servicio rechaza inmediatamente con `ArcaAuthError` (con
`cause` = el error original) sin llamar a WSAA. No aplica a TA vigente, desfase de reloj, abort ni
errores de red sin enviar. `clearTicket`/`clearAllTickets` limpian la espera.

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
const cbu = validateCBU("0110599500000041817221");

// Check sin lanzar error
if (isValidCBU(cbuDelCliente)) {
  // procesar...
}
```

### Fechas (formato AFIP)

```typescript
import { formatDate, parseAfipDate } from "@ramiidv/arca-common";

// Date: fecha calendario en America/Argentina/Buenos_Aires (no depende del TZ del proceso)
formatDate(new Date());          // "20260331"
// Strings YYYYMMDD o YYYY-MM-DD: se formatean literal, sin pasar por Date
formatDate("20260331");          // "20260331"
formatDate("2026-03-31");        // "20260331"
formatDate("20230230");          // ArcaValidationError: la fecha no existe
formatDate("2026/03/31");        // ArcaValidationError: formato no soportado

// Parsear YYYYMMDD o YYYY-MM-DD (exactos) a Date: mediodia de Argentina de ese dia
const fecha = parseAfipDate("20260331"); // 2026-03-31T15:00:00.000Z
formatDate(parseAfipDate("20260331"));   // "20260331" en cualquier zona horaria
```

### SOAP client

```typescript
import { soapCall, afipSoapCall, checkServiceErrors, extractServiceErrors, parseXml, buildXml } from "@ramiidv/arca-common";

// Llamada SOAP de bajo nivel (la respuesta parseada no tiene prefijos de namespace)
const bodyXml = '<FEDummy xmlns="http://ar.gov.afip.dif.FEV1/"/>';
const result = await soapCall("https://wswhomo.afip.gov.ar/wsfev1/service.asmx", bodyXml, {
  timeout: 30_000,
  retries: 2,
  retryDelayMs: 1_000,
  soapAction: "http://ar.gov.afip.dif.FEV1/FEDummy",
  kind: "consulta",            // "emision" = nunca reintentar
  signal: AbortSignal.timeout(60_000),
});

// Llamada SOAP de alto nivel (construye envelope, extrae resultado)
const data = await afipSoapCall(
  "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  "http://ar.gov.afip.dif.FEV1/",
  "FEDummy",
  {},
  {
    qualified: true,            // <FEDummy xmlns="..."> (ASMX, elementFormDefault="qualified")
    soapActionFromMethod: true, // SOAPAction: "http://ar.gov.afip.dif.FEV1/FEDummy"
  },
);
// Otras opciones: requestElement (wrapper del request; null = Body vacio),
// responseElement (default `${method}Response`).

// Verificar errores de negocio en la respuesta (lanza ArcaServiceError)
checkServiceErrors(data, "WSFE");
// O obtenerlos sin lanzar: [{ code, msg, rawCode? }]
const errores = extractServiceErrors(data);

// Utilidades XML
const obj = parseXml("<root><item>1</item></root>");
const xml = buildXml({ root: { item: 1 } });
```

### Manejo de errores

```typescript
import {
  ArcaError,
  ArcaAuthError,
  ArcaTicketVigenteError,
  ArcaSoapError,
  ArcaServiceError,
  ArcaValidationError,
} from "@ramiidv/arca-common";

try {
  const ticket = await wsaa.getAccessTicket("wsfe");
} catch (e) {
  if (e instanceof ArcaTicketVigenteError) {
    // WSAA ya emitio un TA para este cert y servicio y no lo tenemos: esperar a que venza
  } else if (e instanceof ArcaAuthError) {
    // Login WSAA fallo (certificado invalido, expirado, etc.)
    console.error("Auth error:", e.message);
  }

  if (e instanceof ArcaSoapError) {
    // Error HTTP/SOAP (timeout, 5xx, SOAP Fault)
    console.error("HTTP status:", e.statusCode, "fault:", e.faultString);
    // uncertain: el servidor pudo haber procesado el request
    console.error("Resultado incierto:", e.uncertain);
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
console.log(Provincia.CHACO);        // 16 (no existe el 15)
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
| `ticketStorage` | `TicketStorage` | -- | Persistencia de tickets entre reinicios (recomendado) |
| `clockOffsetMs` | `number` | `0` | Offset de reloj `relojARCA - relojLocal` en ms |
| `autoClockSkew` | `boolean` | `true` | Ajustar el offset automaticamente si WSAA rechaza el TRA por reloj |
| `loginErrorCooldownMs` | `number` | `60000` | Espera tras un login fallido antes de volver a llamar a WSAA (`0` = sin espera) |
| `fetch` | `typeof fetch` | `globalThis.fetch` | `fetch` propio (proxy, mTLS, tests) |
| `legacyTls` | `'auto' \| 'never' \| 'always'` | `'auto'` | Transporte TLS legacy para hosts con DH de 1024 bits |

### Metodos de WsaaClient

| Metodo | Retorno | Descripcion |
| --- | --- | --- |
| `getAccessTicket(service, { signal }?)` | `Promise<AccessTicket>` | Obtiene un ticket de acceso (memoria → storage → login, con dedup) |
| `clearTicket(service)` | `Promise<void>` | Invalida el ticket de un servicio (memoria y storage) |
| `clearAllTickets()` | `Promise<void>` | Invalida todos los tickets conocidos por este cliente |
| `ticketKey(service)` | `string` | Key usada en el storage |
| `clockOffsetMs` | `number` | Offset de reloj vigente |
| `now()` | `Date` | Hora actual segun el reloj de ARCA |

### SOAP client

| Funcion | Descripcion |
| --- | --- |
| `soapCall(endpoint, bodyContent, opts?)` | Llamada SOAP de bajo nivel con retry (solo consultas), timeout y `signal` |
| `afipSoapCall(endpoint, namespace, method, params, opts?: AfipSoapCallOptions)` | Llamada SOAP de alto nivel para WS de ARCA (`qualified`, `requestElement`, `responseElement`, `soapActionFromMethod`) |
| `extractMethodResult(parsed, method, { kind, responseElement }?)` | Extrae `{method}Response/*Return` de una respuesta parseada (con o sin prefijos de namespace) |
| `checkServiceErrors(result, serviceName)` | Lanza `ArcaServiceError` si algun error tiene codigo distinto de 0 |
| `extractServiceErrors(result)` | Devuelve los errores de negocio `{ code, msg, rawCode? }[]` sin lanzar |
| `parseXml(xml)` | Parsea XML a objeto JS |
| `buildXml(obj)` | Construye XML desde objeto JS |
| `ensureArray(val)` | Normaliza valor/array/null a array |
| `getNestedValue(obj, ...keys)` | Busca valor probando multiples keys propias; saltea las que valen `null`/`undefined` |

`checkServiceErrors`/`extractServiceErrors` reconocen: WSFE `Errors.Err[]{Code,Msg}`,
`errors.error[]`/`errors.err[]`, servicios Java (WSMTXCA, WSFECRED)
`arrayErrores.codigoDescripcion[]{codigo,descripcion}` y `arrayErroresFormato.codigoDescripcion[]`,
y WSCPE/WSLPG `errores.error[]{codigo,descripcion}`. Si el codigo no es numerico, `code` es `0` y
`rawCode` tiene el original.

### Validators

| Funcion | Retorno | Descripcion |
| --- | --- | --- |
| `validateCuit(cuit)` | `string` | Valida CUIT/CUIL (formato + checksum), retorna 11 digitos. Acepta `string \| number` |
| `isValidCuit(cuit)` | `boolean` | Verifica si un CUIT es valido sin lanzar error |
| `normalizeCuit(cuit)` | `string` | Elimina guiones, acepta `string \| number` |
| `formatCuit(cuit)` | `string` | Formatea como XX-XXXXXXXX-X, acepta `string \| number`; lanza si no son 11 digitos |
| `validateCBU(cbu)` | `string` | Valida CBU (22 digitos + checksums de bloques) |
| `isValidCBU(cbu)` | `boolean` | Verifica si un CBU es valido sin lanzar error |
| `formatDate(date)` | `string` | `Date` → YYYYMMDD en zona Argentina; strings `YYYYMMDD`/`YYYY-MM-DD` literal (valida que la fecha exista) |
| `parseAfipDate(str)` | `Date` | Parsea `YYYYMMDD` o `YYYY-MM-DD` exactos a Date (mediodia de Argentina) |
| `validateFecha(date, fieldName)` | `void` | Valida que sea un Date valido |
| `validateFechaRango(inicio, fin)` | `void` | Valida que fin sea posterior a inicio |
| `collectErrors(fn, errors)` | `void` | Ejecuta validacion y recolecta `ArcaValidationError` sin lanzar (re-lanza cualquier otro error) |
| `collectErrorsWithPrefix(fn, errors, prefix)` | `void` | Como `collectErrors` pero prefija el campo |

### Errores

| Clase | Cuando se lanza | Propiedades extra |
| --- | --- | --- |
| `ArcaError` | Clase base para todos los errores | -- |
| `ArcaAuthError` | Login WSAA fallo, certificado invalido, respuesta inesperada | -- |
| `ArcaTicketVigenteError` | WSAA ya emitio un TA vigente que no esta en memoria ni en el storage | `service` |
| `ArcaSoapError` | Error HTTP, timeout, SOAP Fault | `statusCode?`, `faultCode?`, `faultString?`, `responseDate?`, `uncertain`, `aborted` |
| `ArcaServiceError` | Error de negocio de ARCA (codigos funcionales) | `errors: { code, msg }[]` |
| `ArcaValidationError` | Datos de entrada invalidos | `field?: string`, `details: ValidationErrorDetail[]` |

Los callbacks de `onEvent` nunca rompen una llamada: si lanzan, el error se ignora.

Todos los errores tienen un `code` estable (`"ARCA_AUTH_ERROR"`, `"ARCA_TICKET_VIGENTE"`,
`"ARCA_SOAP_ERROR"`, ...) y `instanceof` funciona aunque haya mas de una copia del paquete
cargada (por ejemplo, el build ESM y el CJS en el mismo proceso). El `code` es estatico en cada clase
(`ArcaSoapError.code`); si definis subclases propias, declara `static readonly code` para que
participen del `instanceof` entre copias.

### Types

| Tipo | Descripcion |
| --- | --- |
| `AccessTicket` | Token + sign + expirationTime (ISO) + generationTime? + service?. Serializable a JSON |
| `TicketStorage` | Interfaz de persistencia de tickets: `get`, `set`, `delete?` |
| `CallOptions` | Opciones por llamada: `signal` |
| `ArcaBaseConfig` | Config base de los SDKs: cert, key, cuit, production, timeout, retries, retryDelayMs, tokenTTLMinutes, onEvent, ticketStorage, clockOffsetMs, autoClockSkew, loginErrorCooldownMs, fetch, legacyTls |
| `SoapCallOptions` | Opciones para llamadas SOAP: timeout, retries, soapAction, onEvent, kind, signal, fetch, legacyTls |
| `AfipSoapCallOptions` | `SoapCallOptions` + requestElement, responseElement, qualified, soapActionFromMethod |
| `ServerStatus` | Estado de servidores: appserver, dbserver, authserver |
| `ArcaEvent` | Union discriminada de eventos del SDK |
| `WsaaClientConfig` | Config del constructor de WsaaClient |
| `ValidationErrorDetail` | Detalle de error: field, message, value |

### Constants

| Constante | Tipo | Descripcion |
| --- | --- | --- |
| `WSAA_ENDPOINTS` | `{ testing, production }` | URLs de los endpoints WSAA |
| `WSAA_NAMESPACE` | `string` | Namespace XML del WSAA |
| `DocTipo` | `enum` | Tipos de documento de `FEParamGetTiposDoc` (CUIT=80, CUIL=86, DNI=96, cedulas provinciales 0-24, etc.) |
| `Provincia` | `enum` | Codigos de provincia de ARCA (0-24, sin 15: Chaco=16, Tierra del Fuego=24) |
| `CondicionIva` | `enum` | Condicion frente al IVA (`CondicionIVAReceptorId` de WSFEv1) |

## Eventos

El SDK emite eventos via el callback `onEvent` para debugging y monitoreo.

| Evento | Cuando | Datos |
| --- | --- | --- |
| `auth:login` | Nuevo token obtenido | `service`, `durationMs` |
| `auth:cache-hit` | Token reutilizado | `service`, `source` (`memory` / `storage`) |
| `auth:clock-skew` | Se ajusto el offset de reloj | `service`, `offsetMs`, `previousOffsetMs` |
| `auth:storage-error` | Fallo el `ticketStorage` (no interrumpe la operacion) | `service`, `operation`, `error` |
| `request:start` | Antes de una llamada SOAP | `method`, `endpoint` |
| `request:end` | Llamada SOAP completada | `method`, `endpoint`, `durationMs` |
| `request:retry` | Reintentando tras error | `method`, `endpoint`, `attempt`, `error` |
| `request:error` | Llamada SOAP fallo | `method`, `endpoint`, `error` |

## Retry automatico

Habilitado por defecto (`retries: 1`) **solo para consultas** (`kind: "consulta"`, incluido el
login de WSAA). Reintenta errores transitorios: timeout, errores de red y HTTP 5xx sin SOAP Fault.
No reintenta SOAP Faults, 4xx ni errores de negocio. Backoff exponencial: `retryDelayMs * 2^(intento-1)`.

Las **emisiones** (`kind: "emision"`, por ejemplo `FECAESolicitar`) nunca se reintentan: si ARCA
proceso el request y la respuesta se perdio, un reintento chocaria con la numeracion. En su lugar,
el error indica `uncertain: true` cuando el servidor pudo haber procesado el request (timeout,
conexion cortada, 5xx, respuesta ilegible o sin SOAP Envelope, SOAP Fault) y `uncertain: false`
cuando hay certeza de que no (falla de DNS, conexion rechazada, 4xx, abortado antes de enviar).

En consultas, un SOAP Fault (con HTTP 500 o 200) es un rechazo deterministico del servidor:
`uncertain: false` y no se reintenta. Una respuesta 2xx que no es SOAP (por ejemplo, una pagina
HTML de mantenimiento) se trata como error de transporte y se reintenta.

## TLS legacy (DH de 1024 bits)

Algunos hosts de produccion de ARCA (`servicios1.afip.gov.ar`: WSFEv1, WSCDC) negocian
Diffie-Hellman de 1024 bits, que Node >= 17 rechaza con `ERR_SSL_DH_KEY_TOO_SMALL`. Con
`legacyTls: "auto"` (default), si el `fetch` por defecto falla por ese motivo, el mismo request
se reintenta una vez con un transporte `node:https` con `ciphers: "DEFAULT@SECLEVEL=1"` (es seguro
incluso en emisiones: el handshake fallo y el request no se envio), y el host se recuerda para las
llamadas siguientes. `"never"` lo desactiva y `"always"` lo usa siempre. Con un `fetch` inyectado
no hay fallback.

```typescript
// Configurar retries
const wsaa = new WsaaClient({
  ...config,
  retries: 2,          // 2 reintentos (3 intentos totales)
  retryDelayMs: 2000,  // 2s, 4s
});
```

## Ejemplos

Ver la carpeta [`examples/`](./examples/) para ejemplos completos:

- [`autenticacion-wsaa.ts`](./examples/autenticacion-wsaa.ts) — Login WSAA, cache de tokens, invalidacion
- [`validar-cuit-cbu.ts`](./examples/validar-cuit-cbu.ts) — validateCuit, isValidCuit, formatCuit, CBU
- [`fechas-afip.ts`](./examples/fechas-afip.ts) — formatDate, parseAfipDate
- [`manejo-errores.ts`](./examples/manejo-errores.ts) — Jerarquia completa de errores

## Licencia

MIT
