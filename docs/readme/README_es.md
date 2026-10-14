<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Deutsch](README_de.md) · **Español** · [Français](README_fr.md) · [Русский](README_ru.md)

# dsh-unreal-agentlink

### Un plugin de DSH que pone tu editor de Unreal bajo tu agente.

**Puente puro. El agente planifica; este plugin solo traduce.**

```
DSH agent  ──tool calls──►  dsh-unreal-agentlink  ◄──WebSocket──  Unreal Editor
(plans, decides)            (this plugin: server, translator)   editor dials out
```

[Instalación](#instalación) · [Requisitos](#requisitos) · [12 herramientas](#12-herramientas) · [Configuración](#configuración) · [Documentación](#documentación)

<code>npm install &amp;&amp; npm run check</code>

</div>

---

Tu agente ya sabe leer archivos y ejecutar comandos. Este plugin le entrega el editor en sí: consultar el nivel, generar actores, editar blueprints y materiales, renderizar secuencias, tomar capturas de pantalla que puede *ver* de verdad, y revertir su propio trabajo cuando algo sale mal.

No planifica tareas. La planificación pertenece al agente nativo de DSH. Este plugin es un traductor con una capa de seguridad — convierte la intención del agente en comandos de UnrealAgentLink y las respuestas del editor en algo sobre lo que un agente puede actuar.

---

## Instalación

Tres partes: poner el plugin de C++ UnrealAgentLink en tu proyecto de UE, instalar este plugin en DSH y abrir el editor. Eso es todo — **sin UEBox, sin token, sin handshake**.

### Paso 1 — instalar UnrealAgentLink en el proyecto de UE

1. Copia todo el directorio `UnrealAgentLink` en el `Plugins/` de tu proyecto (o en el `Plugins/` del motor para una instalación global).
2. Regenera los archivos del proyecto y ábrelo.
3. Confirma que UnrealAgentLink está habilitado en **Edit → Plugins**. Incorpora automáticamente dos dependencias distribuidas con el motor, `IKRig` y `PythonScriptPlugin`.

A partir de entonces el editor se conecta saliente por sí solo: `StartupModule` llama incondicionalmente a `Init("ws://127.0.0.1:17860")` y reintenta cada 5 segundos, así que **el orden de arranque no importa**.

> ¿El puerto ya está ocupado (por ejemplo por UEBox)? Dale al editor uno distinto y haz que coincida de este lado:
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`

### Paso 2 — instalar este plugin en DSH

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck (src + tests) + 173 tests + catalog + doc reconciliation, one command
```

`npm run check` debe estar completamente en verde antes de continuar — verifica que las fuentes y las pruebas pasan la comprobación de tipos, que las pruebas de comportamiento pasan, y que el catálogo de 170 comandos coincide con el registro de C++ entrada por entrada.

Luego regístralo como bundle de DSH. `package.json` declara `dsh.bundle.patch: ./cordis.patch.yml`, y ese archivo hace una sola cosa:

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

> **Capas de configuración**: una capa posterior **reemplaza** el `config` de esa fila por completo en lugar de fusionarlo en profundidad. Para sobrescribir cualquier cosa, reescribe todas las claves que quieras conservar.

DSH no distribuye ningún comando que instale un plugin local fuera del árbol, y `dsh plugin --profile desktop` se rechaza directamente porque la aplicación Electron gestiona ese perfil en exclusiva (`bin.js:38`). Así que este repositorio incluye un instalador que hace el trabajo y luego se remite al de verdad:

```bash
npm run status:dsh -- --profile web     # what is registered right now (same script, npm passthrough)
node scripts/install-dsh-plugin.mjs --profile web             # mirror, edit the manifest, install, verify
```

Rechaza el perfil `desktop`, se niega a tocar un manifiesto que una DSH en ejecución todavía retiene, y demuestra que la capa está compuesta antes de informar del éxito (`dsh --profile web --dump-config` debe contener `# == dsh-unreal-agentlink`). Si la guarda de dependencias entre pares detiene la instalación, imprime el comando exacto para aceptar el riesgo — **esa decisión es tuya, no la del script**.

Dos caminos más, ambos escritos: la [instalación manual](#instalación-manual-sin-el-script) de abajo, e [INSTALL-ai.md](../es/INSTALL-ai.md) — una versión que un agente de IA puede leer y seguir paso a paso.

### Paso 3 — abrir el proyecto y verificar

Abre el proyecto de UE, luego pide al agente que llame a `ual_status` y comprueba tres campos:

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → el plugin no arrancó, o el puerto está ocupado. Busca `EADDRINUSE` en el registro de DSH.
- `listening: true` pero `editors: []` → el puente está esperando. Confirma que el proyecto de UE está abierto y que UnrealAgentLink está habilitado.

Durante el **primer instante** después de que un editor se conecta, su registro solo tiene `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`; campos como `project` aparecen solo una vez que el editor envía `project.info`. Es un estado normal, no un error.

Luego prueba una lectura pura sin efectos secundarios:

```
ual_call { method: "level.get_current" }
```

**El recorrido completo — flujos de trabajo, lectura de fallos, solución de problemas — está en el [tutorial](../es/01-tutorial.md).**

### Instalación manual sin el script

El script de arriba es una comodidad; el mecanismo subyacente son cuatro líneas de manifiesto más un comando de producto. Donde `<profile>` es `web` (o cualquier perfil que no sea desktop) y `$DSH_HOME` es `~/.dsh` por defecto:

```bash
# 1. build once, then copy only what npm pack ships
npm run build
cp -r lib cordis.patch.yml package.json LICENSE README.md \
      "$DSH_HOME/profiles/<profile>/.vendor/"

# 2. register the dependency and the bundle layer (both are required)
"$DSH_HOME/profiles/<profile>/package.json"    # add the two entries shown below

# 3. let the real installer run
dsh plugin --profile <profile> install

# 4. prove the layer is composed
dsh --profile <profile> --dump-config | grep -A2 '# == dsh-unreal-agentlink'
```

Las dos entradas, en `<profile>/package.json`:

```json
"dependencies": { "dsh-unreal-agentlink": "file:C:/Users/you/.dsh/profiles/web/.vendor" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-unreal-agentlink"] } }
```

Ambas son obligatorias y fallan de forma distinta: un paquete listado que no declara `dsh.bundle` falla **ruidosamente** al arrancar, mientras que un paquete instalado que no está listado no aporta **ninguna capa** y no aparece nada en `--dump-config`.

**Por qué `file:` apunta a una copia y no a tu espacio de trabajo**: pnpm copia lo que encuentra en el momento de la instalación, así que un archivo fuente guardado a medias — o un `lib/` borrado tras una compilación fallida — se convierte en el plugin que DSH carga. Primero refleja, después instala.

**El perfil `desktop` no tiene ruta por CLI.** `bin.js:38` lo rechaza porque la aplicación Electron lo gestiona en exclusiva, y esa aplicación retiene un bloqueo `wx` sobre `desktop/package.json` mientras se ejecuta (`dsh-atomic-write`, y un contendiente nunca borra el bloqueo de otro portador). Tus opciones son el gestor de plugins de la propia GUI, o cerrar la aplicación y hacer a mano los cuatro pasos de arriba. Instalar primero en `web` y copiar el resultado encima es lo menos invasivo.

---

## Requisitos

| Elemento | Requisito |
|---|---|
| Unreal Engine | 5.0 – 5.8 |
| UnrealAgentLink | el plugin de C++ en sí, copiado en el `Plugins/` de tu proyecto |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Runtime de DSH | este plugin instalado como bundle |

### No necesita UEBox

La aplicación de escritorio UEBox **no es una dependencia**. Es otro cliente del mismo proveedor que por casualidad también usa el puerto 17860, así que ejecutar ambos a la vez es un conflicto de puertos — esa es toda la relación. Las pruebas:

- `UnrealAgentLink.uplugin:25-34` declara exactamente dos dependencias, ambas distribuidas con el motor: `IKRig` y `PythonScriptPlugin`. Ningún módulo de uebox.
- Cada entrada de `UnrealAgentLink.Build.cs` es un módulo del motor (UnrealEd / AssetRegistry / MovieScene / Landscape …). Ningún SDK de uebox.
- La cadena `uebox` aparece tres veces en todo el código fuente, todas ellas cabeceras `// Copyright uebox.ai`.
- Nada en el código fuente llama a uebox.ai. El único uso de `FHttpModule` lee la configuración de proxy de la máquina local (`UAL_ProxyDiagnostics.cpp:167`).

Una vez que el plugin está en tu proyecto, funciona por sí solo: `StartupModule` llama incondicionalmente a `Init("ws://127.0.0.1:17860")` (`Core/UnrealAgentLink.cpp:86-97`), envía `project.info` en el instante en que se conecta, y no tiene handshake, token ni autenticación.

> Para mover el puerto: `-UALServer=ws://127.0.0.1:17861` del lado del editor, y la configuración `port` de este lado.

---

## Documentación

| Documento | Contenido |
|---|---|
| [Tutorial](../es/01-tutorial.md) | De extremo a extremo: instalar el plugin, conectarlo, flujos de trabajo habituales, solución de problemas |
| [Referencia del protocolo](../es/02-protocol.md) | Formas de los mensajes, eventos, los 13 códigos de estado, reglas de serialización, semántica de tiempo de espera y concurrencia |
| [Arquitectura](../es/03-architecture.md) | La cadena de compuertas, aislamiento de sesión y reversión, traducción de errores, estrategia de verificación, las trampas que encontramos |
| [Referencia de comandos](../es/command-reference.md) | Parámetros / claves obligatorias / claves de resultado / códigos de estado de los 170 comandos (**generado**) |
| [Guía de instalación (legible por IA)](../es/INSTALL-ai.md) | El procedimiento de instalación escrito para que un agente de IA lo lea y lo ejecute, con las comprobaciones que debe hacer antes y después |

Los cinco existen en todos los idiomas listados al principio de este archivo, en `docs/<lang>/` — `en` (canónico, directamente en `docs/`), `zh`, `zh-TW`, `ja`, `ko`, `de`, `es`, `fr`, `ru`.

---

## Cuatro hechos para establecer primero

No son decisiones de diseño. Son restricciones existentes de UnrealAgentLink, y determinan cómo se escribe cada operación.

1. **La dirección está invertida.** Este plugin no llama al editor — **el editor se conecta saliente**. El orden de arranque no importa: abre el editor primero y reintentará cada 5 segundos hasta que aparezca el plugin.
2. **No hay autenticación.** Sin token, sin cabecera, sin subprotocolo. **El puerto es la credencial**, por lo que por defecto solo se enlaza a loopback. No lo cambies a `0.0.0.0`.
3. **Los comandos se ejecutan en serie en el hilo de juego.** Y mientras se ejecuta un comando bloqueante, **el editor no responde nada** — ni siquiera una consulta de progreso como `sequence.render_status`.
4. **No hay cancelación.** `query_task` y `cancel_task` no existen. Matar un trabajo de `ual_task` solo detiene la espera de este plugin; el motor sigue en marcha y el resultado sigue llegando.

---

## 12 herramientas

Exponer los 170 comandos como 170 herramientas gastaría una gran parte del prompt de cada solicitud en capacidades que una tarea dada nunca toca. Así que descubrir la capacidad toma dos pasos, no cero:

| Herramienta | Propósito |
|---|---|
| `ual_status` | Conexiones del editor / disyuntor / límite de tasa / sesión / comandos huérfanos. **Lee esto primero cuando algo vaya mal** |
| `ual_tools` | Lista los 170 comandos (22 familias), filtrable por familia o palabra clave |
| `ual_schema` | Los **nombres de clave exactos** de un comando — compruébalo antes de llamar; UE ignora en silencio las claves desconocidas |
| `ual_call` | Ejecuta un comando, devuelve el resultado del editor tal cual |
| `ual_batch` | Varios comandos en un solo viaje de ida y vuelta (limitado por `maxBatchCalls`; un elemento peligroso somete todo el lote a aprobación) |
| `ual_screenshot` | Captura y devuelve una **imagen real** que el agente puede ver |
| `ual_logs` | Lee el anillo de registros local (el reenvío del lado de UE está desactivado por defecto — consulta el tutorial) |
| `ual_undo` / `ual_undo_history` | Reversión por sesión / inspección del búfer de deshacer |
| `ual_locks` | Reclama bloqueos de assets; el editor dibuja una insignia de "AI is editing" |
| `ual_editor_bind` | Fija una sesión a un editor cuando hay varios conectados |
| `ual_task` | Convierte un comando bloqueante largo en un trabajo en segundo plano real para que la conversación continúe |

### Niveles de riesgo

read 65 / write 89 / **destructive 2 / dangerous 14** (los últimos 16 pasan por aprobación).

`tools/pre-execute` devuelve `{kind:'ask'}` para los métodos destructive y dangerous (incluido cualquier elemento dangerous dentro de un `ual_batch`), dejando la decisión a la política de sesión. **Un método no registrado se deniega directamente** y nunca llega al editor.

Ten en cuenta que bajo una política `never`, `ask` se rechaza automáticamente — que es la lectura correcta de «las sesiones desatendidas no deben tocar el editor».

---

## Configuración

Los valores predeterminados son «vivos pero perezosos». La tabla completa con su razonamiento está en [tutorial §7](../es/01-tutorial.md#7-configuración).

| Clave | Predeterminado | Significado |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `17860` | Mantenlo en loopback: sin autenticación, alcanzar el puerto significa controlar el editor |
| `timeoutMs` | `180000` | Los comandos bloqueantes elevan sus propios mínimos |
| `cacheTtlMs` / `cacheMaxEntries` | `2000` / `128` | Caché de lectura por sesión |
| `rateLimitRps` / `rateLimitQueue` | `5` / `32` | Comandos por segundo / tope de la cola (0 desactiva la limitación de tasa) |
| `breakerThreshold` / `breakerCooldownMs` | `3` / `30000` | Fallos de transporte consecutivos para abrir / enfriamiento |
| `logCapacity` / `logMinLevel` | `512` / `Display` | Anillo de registros |
| `logForwardingEnabled` | `false` | Ponlo en `true` solo después de ejecutar `ual.ForwardLogs` dentro del editor |
| `rollbackOnDispose` | `false` | Solo un sufijo LIFO es exacto — consulta el documento de arquitectura |
| `notifyOnEditorChange` | `true` | Inyecta una línea en el agente cuando un editor se conecta o se cae |
| `screenshotAttachments` / `screenshotMaxBytes` | `true` / 12MB | Bloques de imagen / tope de tamaño |
| `maxBatchCalls` | `12` | Tope por `ual_batch` |

---

## Desarrollo

```bash
npm run build       # tsc → lib/
npm run dev         # tsc --watch
npm run check       # typecheck + tests + catalog reconciliation (run before committing)
npm test            # tests only
npm run typecheck   # src and tests typechecked separately
```

### Estructura del código fuente

```
src/
  index.ts                  Cordis lifecycle, approval gate, dispose-time rollback
  config.ts                 Schemastery schema (the single source of default values)
  service.ts                call() gate chain: catalog → requires → read cache → breaker → rate limit → send → ledger → translate
  protocol/{bridge,serialization,types}.ts   WS server / outbound validation / wire types
  catalog/{method-data,method-overrides,methods}.ts   170-command catalog (data extracted from C++)
  errors/translate.ts       Error classification (by class name / status code, never by message text)
  resilience/breaker.ts     Rate limiter + circuit breaker
  sessions/state.ts         Session ledger / LIFO test / lock merging / cache / log filtering
  tools/                    The 12 tools
scripts/                    Catalog extraction and reconciliation, doc generation and normalization,
                              the language set, and the DSH profile installer
                              (scripts/install-dsh-plugin.mjs)
docs/                       Tutorial / protocol / architecture / command reference / install guide,
                              in 9 languages
tests/                      173 tests
```

### Archivos generados: no editar a mano

`src/catalog/method-data.ts` y `docs/command-reference.md` son ambos **generados**:

```bash
node scripts/extract-methods.mjs .ua-ref/plugin/UnrealAgentLink/Source   # rebuild the catalog from C++
npm run build && node scripts/gen-docs.mjs                             # rebuild the command reference
```

Una tabla mantenida a mano que nadie importa es una clase de defecto recurrente en este proyecto (`REQUIRED_KEYS`, `EXTRA_PARAM_KEYS` y `UAL_CODES` ya han sido capturadas por ella). La contramedida es hacer que cada verificación **pregunte a la fuente** en lugar de preguntarle a la tabla — consulta [architecture §9](../es/03-architecture.md#9-archivos-generados-y-tablas-que-nadie-importa).

### Pruebas y verificaciones

```bash
npm run check                       # typecheck (src + tests) + 173 passed + catalog reconciliation
npm test                            # 173 passed
node scripts/check-catalog.mjs      # 170/170 zero drift; every requires key appears in C++; code set matches C++
node scripts/gen-docs.mjs --check   # is the command reference up to date
```

Los siete archivos de prueba se dividen por **el tipo de defecto que pueden detectar**, cada uno por una razón — consulta [architecture §11](../es/03-architecture.md#11-estrategia-de-verificación).

`requires` no está escrito a mano: se deriva de los propios mensajes `SendError(..., 400, "Missing field: X")` de los handlers (28 sitios), porque una clave obligatoria incorrecta hace que el puente rechace una llamada *válida* antes de que el motor la vea. El resultado se materializa en `method-data.ts` como `REQUIRED_KEYS`, y `requiresOf()` de `methods.ts` lo fusiona en el uso en tiempo de ejecución (el rechazo temprano en `service.call()`, la línea `REQUIRED:` en `ual_schema` y las sugerencias de error pasan todas por esa única función).

Deliberadamente **solo restringe, nunca amplía**: un mensaje que contiene `or` (`"Missing field: name or path"`) se omite por completo, y las claves recolectadas de una función llamada en el mismo archivo se descartan como locales de rama — consulta `REQUIRED_DROPPED` en `scripts/extract-methods.mjs`, donde cada entrada cita su número de línea de C++. Así que «no se recolectó ninguna clave» es el valor predeterminado seguro, no una verificación perdida.

---

## Aspectos esenciales del protocolo

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }     // id is generated by the server
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }        // the key is omitted when empty
UE → plugin:  { ver,       type:"evt", method, payload }
```

- El fallo se expresa **solo mediante `code`**. No hay un campo `error` a nivel de envoltura.
- El texto legible por humanos está en `result.message` (chino o inglés según la cultura del editor — **no lo analices**); el detalle legible por máquina está en `result.details`.
- **Muchos handlers devuelven `200` con `result.ok === false`** (`editor.undo`, `blueprint.compile`, `pie.observe`), por lo que el plugin juzga el éxito con `judge()`, no solo por el código. Hay 55 sitios con `SetStringField(TEXT("error"), ...)` repartidos en 14 archivos de C++ — esto es la norma, no una anomalía.
- `content.import_folder` / `content.import_assets` son **envíos salientes de disparar y olvidar**: sin `id`, sin respuesta esperada. El plugin los convierte en registros y notificaciones al agente y **no fabrica un `res`** — responder `ok:false` solo mostraría al usuario un diálogo falso de "import failed", que es peor que el silencio.

El detalle completo (los 13 códigos de estado, las reglas de serialización, la semántica de tiempo de espera) está en la [referencia del protocolo](../es/02-protocol.md).

---

## Licencia

MIT
