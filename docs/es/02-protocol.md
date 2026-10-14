<div align="center">

[English](../02-protocol.md) · [简体中文](../zh/02-protocol.md) · [繁體中文](../zh-TW/02-protocol.md) · [日本語](../ja/02-protocol.md) · [한국어](../ko/02-protocol.md) · [Deutsch](../de/02-protocol.md) · **Español** · [Français](../fr/02-protocol.md) · [Русский](../ru/02-protocol.md)

[README](../readme/README_es.md) · [Tutorial](01-tutorial.md) · **Protocolo** · [Arquitectura](03-architecture.md) · [Referencia de comandos](command-reference.md)

</div>

# Referencia del protocolo

El protocolo de cable de UnrealAgentLink. Este plugin es el **servidor**; el editor de Unreal es el **cliente**.

Cada conclusión de aquí proviene del C++ bajo `.ua-ref/plugin/UnrealAgentLink/Source/UnrealAgentLink/`, con referencias de archivo y línea en los puntos clave.

---

## 1. Conexión

| Elemento | Valor | Prueba |
|---|---|---|
| Dirección | UE se conecta saliente | `Network/UAL_NetworkManager.cpp:77` `CreateWebSocket(TargetUrl)` |
| Dirección predeterminada | `ws://127.0.0.1:17860` | `Core/UnrealAgentLink.cpp:88` |
| Cómo cambiarla | línea de comandos `-UALServer=ws://host:port` | `Core/UnrealAgentLink.cpp:90` |
| Autenticación | **ninguna** — sin token, cabecera ni subprotocolo | `CreateWebSocket` solo acepta una URL |
| Reconexión | un ciclo fijo de 5 segundos, sin retroceso | `Network/UAL_NetworkManager.cpp:116` |
| Protección contra estancamiento de conexión | sí (`ConnectTimeoutSeconds`) | `Network/UAL_NetworkManager.cpp:145-155` |

Este plugin escucha en el 17860 con un `maxPayload` de 64 MB.

### Verificación del origen

Solo se aceptan orígenes de loopback (`127.*`, `::1`, `::ffff:127.*`). Solo se amplía cuando el `host` configurado se ha establecido **deliberadamente** en algo distinto de `127.0.0.1` / `localhost`. La razón está en «sin autenticación» — el puerto es la credencial.

### Handshake

**No hay handshake.** Un editor envía `project.info` inmediatamente al conectarse, y este plugin lo usa para marcarlo como identificado (`editor-identified`). Antes de que llegue, la conexión está «conectada pero sin identificar» — tal registro en `ual_status` solo tiene `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`, sin `project` ni similares.

---

## 2. Formas de los mensajes

### req (este plugin → editor)

| Campo | Significado | Verificado por |
|---|---|---|
| `ver` | fijo `"1.0"` | `protocol/types.ts` |
| `type` | fijo `"req"` | `protocol/types.ts` |
| `method` | el nombre del comando; **no se comprueba en el lado UE** — un nombre desconocido devuelve directamente 404 | `Commands/UAL_CommandHandler.cpp:87-94` |
| `id` | **generado por este plugin** | `protocol/bridge.ts` |
| `params` | parámetros del comando | `Commands/UAL_CommandHandler.cpp:87-94` |

`id` no debe estar vacío: la primera línea de `SendResponse` es `if (RequestId.IsEmpty()) { return; }` (`Utils/UAL_CommandUtils.cpp:2503-2506`) — **una solicitud sin id nunca recibe respuesta**.

En el lado del editor, el análisis (`Commands/UAL_CommandHandler.cpp:87-94`) lee primero `params` y retrocede al campo heredado `payload`. Este plugin solo envía `params`.

### res (editor → este plugin)

| Campo | Significado | Verificado por |
|---|---|---|
| `ver` | fijo `"1.0"` | `protocol/types.ts` |
| `type` | fijo `"res"` | `protocol/types.ts` |
| `id` | hace eco del `id` de la solicitud | `Commands/UAL_CommandHandler.cpp` |
| `code` | entero 200 – 504 | `protocol/types.ts` `UAL_CODES` |
| `result` | datos de éxito o `{message, details}` | `protocol/types.ts` |

La lógica de omisión está en `Utils/UAL_CommandUtils.cpp:2513-2516`: `result` se escribe solo cuando `Data.IsValid()`. Es decir, **en una respuesta sin resultado la clave `result` está ausente**, no presente con `null` — y la comprobación de tipos en este lado ya lo tiene en cuenta.

### evt (editor → este plugin, push unidireccional)

| Campo | Significado | Verificado por |
|---|---|---|
| `ver` | presente cuando el evento se envía mediante `SendEvent`; **los eventos de importación de la extensión del navegador de contenido no lo llevan** | `protocol/types.ts` |
| `type` | fijo `"evt"` | `protocol/types.ts` |
| `method` | el nombre del evento | `protocol/types.ts` |
| `payload` | datos del evento | `protocol/types.ts` |
| `id` | **no existe** — los eventos no admiten respuesta | `protocol/types.ts` |

En el lado del editor, el análisis del cuerpo de respuesta (`Commands/UAL_CommandHandler.cpp:98-104`) prueba `result` → `data` → `payload` en ese orden. Este plugin envía `result`.

---

## 3. Cómo se expresa el fallo

**Solo mediante `code`.** No hay **ningún** campo `error` a nivel de envoltura en el mensaje.

| Código | Significado | Clase de este plugin |
|---|---|---|
| `200` | éxito | — |
| `207` | éxito parcial | `partial: true` |
| `400` | falta un parámetro o está mal tipado | `bad-params` |
| `404` | no existe ese método o asset | `not-found` |
| `409` | conflicto (p. ej. ya se está ejecutando un perfilador exclusivo) | `conflict` |
| `410` | eliminado | `not-found` |
| `412` | precondición no cumplida | `precondition` |
| `413` | por encima de un tope (p. ej. creación por lotes más allá de un límite de cvar) | `precondition` |
| `422` | entrada válida pero no se escribió nada | `precondition` |
| `500` | error interno del editor | `engine-error` |
| `501` | no admitido en esta versión | `unsupported` |
| `503` | el registro de assets todavía está escaneando | `registry-busy` |
| `504` | tiempo de espera del lado del editor | `timeout` |

El `0` **nunca se usa**. Estos 13 códigos están definidos en `protocol/types.ts` como `UAL_CODES`, y la comprobación 4 de `scripts/check-catalog.mjs` consulta directamente el código fuente de C++ para ellos — incluido un 503 emitido por compuertas compartidas como `FUAL_RegistryReady::Ensure`, y formas de expresión como `Code = bOk ? 200 : 207`. Un código que falte o sobre falla la comprobación.

### Dónde vive el texto del error

```
result.message   ← for humans, Chinese or English by editor culture, never parse it
result.details   ← for machines (suggestions / expected_type / registry progress)
```

`SendError` construye `{message: ...}`, y la sobrecarga de 4 argumentos adjunta también `details` (`Utils/UAL_CommandUtils.cpp:2525-2539`).

### Un 200 todavía puede ser un fallo

**Esta es la trampa más fácil de pisar.** Muchos handlers devuelven `200` con `result.ok === false`:

- `editor.undo` — cuando no hay nada que deshacer
- `blueprint.compile` — cuando la compilación tiene errores
- `pie.observe` — cuando la observación falla

Así que este plugin juzga el éxito con `judge(result, code)` en lugar de solo el código:

| Situación | Veredicto |
|---|---|
| `code === 200`, `result.ok !== false`, `result.error` vacío | éxito |
| `code === 207` | éxito, pero `partial: true` |
| `result.ok === false` | **fallo** |
| `result.error` es una cadena no vacía | **fallo** |
| `result` no es un objeto (o está ausente) | juzgar por código; no adivinar |

Esta regla es **necesaria**: hay 55 sitios con `SetStringField(TEXT("error"), ...)` repartidos en 14 archivos de C++. En otras palabras, «un 200 con un error no vacío» es la norma, no una anomalía.

---

## 4. Eventos

| Método | Cuándo | Carga útil |
|---|---|---|
| `project.info` | inmediatamente al conectarse, en lugar de un handshake | nombre del proyecto, ruta, versión del motor, versión del plugin, modo de ejecución, nivel actual, disponibilidad de Python y más |
| `project.closed` | el editor cierra el proyecto | — |
| `system.heartbeat` | cada **10 segundos** | `{}` (**siempre presente**, no se omite) |
| `log.entry` | salida del registro de UE (requiere el cvar `ual.ForwardLogs 1`) | `text` / `category` / `level` |
| `content.import_folder` | el usuario elige «import to UnrealBox asset library» en el menú contextual del navegador de contenido | `paths` / `real_paths` / `asset_metadata` |
| `content.import_assets` | como arriba, iniciado desde el viewport del nivel | `asset_paths` / `asset_real_paths` / `asset_metadata` |

### Heartbeats y declarar un editor muerto

Los heartbeats son un **temporizador independiente de 10 segundos** (`Network/UAL_NetworkManager.cpp:173`), sin relación con la reconexión de 5 segundos. Este plugin marca un editor como `stale` después de **45 segundos** sin heartbeat — coincidiendo con el front end (`Network/UAL_NetworkManager.cpp:172`).

### Los dos eventos de importación son fire-and-forget

No llevan **ningún `id`**, y el editor **no espera respuesta**. El `Handle_Response` del lado del editor (`Commands/UAL_CommandHandler.cpp:185-297`) solo muestra una notificación de Slate cuando recibe `type:"res"`, leyendo `ok` / `count` / `importedPath` / `error`.

Este plugin es un puente puro sin capacidad para importar assets, así que convierte los eventos en **registros y notificaciones al agente** y **no fabrica un `res`** — responder `ok:false` solo mostraría al usuario un diálogo falso de "import failed", que es peor que el silencio.

---

## 5. Reglas de serialización

Los parámetros de salida pasan por `toSerializable()` en `protocol/serialization.ts` antes de salir al cable. Es más estricto que `JSON.stringify`, porque **UE trata un campo que no puede leer como «no enviado»** — no hacer nada en silencio es más difícil de diagnosticar que un error.

| Entrada | Tratamiento |
|---|---|
| `null` / booleano / cadena | tal cual |
| número finito | tal cual |
| **número no finito** (`NaN` / `Infinity`) | **lanza excepción** — UE lo leería como «campo ausente» |
| `undefined` (nivel superior, o dentro de un array) | **lanza excepción** |
| `undefined` (como valor de una propiedad de objeto) | **la clave se descarta** |
| función / símbolo / bigint | **lanza excepción** |
| referencia circular | **lanza excepción** |
| `Uint8Array` | se convierte en una cadena base64 |
| `Date` | se convierte en una cadena ISO |
| `Map` (las claves deben ser cadenas) | se convierte en un objeto plano |
| `Set` | se convierte en un array |
| otros objetos no planos (instancias de clase, etc.) | **lanza excepción** |

Solo pasan los objetos planos, los arrays y los escalares JSON.

---

## 6. Temporización y concurrencia

**Los comandos para un editor son seriales.** Este plugin mantiene una cola de envío por editor, encadenando cada comando al `then` del anterior. Esto no es para satisfacer el protocolo — es porque el editor ejecuta de forma sincrónica hasta completarse en el hilo de juego de todos modos.

**Las colas son independientes entre editores.** Cuando se conectan varios editores, cada uno obtiene su propia cola.

### Tiempos de espera

El predeterminado es 180 segundos, y los comandos bloqueantes elevan sus propios mínimos (la columna de tiempo de espera de `ual_schema` los marca como "blocking").

**Un tiempo de espera no significa que el comando no se ejecutara.** Solo significa que este plugin dejó de esperar. Cuando eso ocurre:

1. El editor se marca como teniendo un comando huérfano (`orphaned` en `ual_status`).
2. Los **comandos cortos posteriores al mismo editor se rechazan directamente** (`queue-stalled`), en lugar de encolarse detrás de un trabajo que puede que nunca vuelva.
3. Una llamada con `long: true` todavía se puede enviar — así es como se expresa «estoy dispuesto a esperar».

**Lo mismo se aplica a las llamadas abortadas**: matar un trabajo de `ual_task` pasa por abort, y abort solo detiene la espera de este plugin mientras el motor sigue funcionando. Así que un abort también registra un huérfano.

### Desconexión

Cuando un editor se desconecta, todas las solicitudes en vuelo para él fallan con `editor-lost`, y el error lleva todos los nombres de método.

---

## 7. Lo que este plugin no envía

Para ser explícitos sobre el límite:

- **Ningún token** — no hay mecanismo de autenticación.
- **Ningún `GET /api/ual/action`** — documentación antigua describía esto como un servicio HTTP; es incorrecto.
- **Ningún sondeo de tareas** — `query_task` / `cancel_task` no existen.
- **Ningún `res` fabricado** — consulta la sección de eventos de importación.
- **Ninguna reconexión activa al editor** — la dirección está invertida; el editor reintenta cada 5 segundos por su cuenta.

---

## 8. Archivos relacionados

| Archivo | Contenido |
|---|---|
| `src/protocol/types.ts` | tipos de mensaje, `UAL_CODES`, `UalError` |
| `src/protocol/bridge.ts` | servidor WebSocket, colas, tiempos de espera, huérfanos, anillo de registros |
| `src/protocol/serialization.ts` | todas las reglas de serialización de la tabla anterior |
| `src/service.ts` | `judge()`, la cadena de compuertas, el libro mayor |
| `src/errors/translate.ts` | código de estado / nombre de clase → 16 clases |

Contrapartes en C++: `Utils/UAL_CommandUtils.cpp` (`SendResponse` / `SendError` / `SendEvent`), `Commands/UAL_CommandHandler.cpp` (despacho de entrada), `Network/UAL_NetworkManager.cpp` (conexión, heartbeat, reconexión).
