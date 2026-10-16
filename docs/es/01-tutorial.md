<div align="center">

[English](../01-tutorial.md) · [简体中文](../zh/01-tutorial.md) · [繁體中文](../zh-TW/01-tutorial.md) · [日本語](../ja/01-tutorial.md) · [한국어](../ko/01-tutorial.md) · [Deutsch](../de/01-tutorial.md) · **Español** · [Français](../fr/01-tutorial.md) · [Русский](../ru/01-tutorial.md)

[README](../readme/README_es.md) · **Tutorial** · [Protocolo](02-protocol.md) · [Arquitectura](03-architecture.md) · [Referencia de comandos](command-reference.md)

</div>

# Tutorial: de cero a un puente en funcionamiento

Este es el recorrido de extremo a extremo. El objetivo: dejar que un agente dentro de DSH controle de verdad tu editor local de Unreal, y sepa qué debe hacer y qué se va a colgar.

Orden de lectura sugerido: esta página → [protocolo](02-protocol.md) → [arquitectura](03-architecture.md) → [referencia de comandos](command-reference.md).

---

## 1. Modelo mental: cuatro hechos primero

Antes de tocar nada, estos cuatro hechos determinan cómo se escribe cada operación posterior. No son decisiones de diseño — son restricciones existentes de UnrealAgentLink.

**① La dirección está invertida.** Este plugin no llama al editor — **el editor se conecta saliente**. El plugin de C++ UnrealAgentLink abre incondicionalmente `ws://127.0.0.1:17860` en `StartupModule`, y este plugin escucha en ese puerto. Así que el orden de arranque no importa: si el editor arranca primero, reintenta cada 5 segundos y aun así se conecta una vez que el plugin aparece.

**② No hay autenticación.** Sin token, sin cabecera, sin subprotocolo. **El puerto en sí es la credencial** — quien pueda alcanzar el 17860 puede controlar el editor. Por eso se enlaza solo a loopback por defecto, y por eso no deberías cambiarlo a `0.0.0.0`.

**③ Los comandos se ejecutan en serie en el hilo de juego.** Cuando el editor recibe un comando, lo vuelve a publicar en el hilo de juego si no está ya ahí, y luego **lo ejecuta de forma sincrónica hasta completarlo**. Dos consecuencias:

- Los comandos para el mismo editor se encolan de forma natural, y este plugin también envía por editor en serie.
- **Mientras se ejecuta un comando bloqueante, el editor no responde nada** — ni siquiera una consulta de progreso como `sequence.render_status`. Todo lo demás que envíes simplemente se encola detrás.

**④ No hay cancelación.** `query_task` / `cancel_task` no existen en el protocolo. Matar un trabajo de `ual_task` detiene solo **la espera de este plugin**; el motor sigue funcionando y el resultado sigue llegando. Esta frase está escrita en la descripción de la herramienta `ual_task` para que la lea el modelo.

---

## 2. Requisitos previos

| Elemento | Requisito | Notas |
|---|---|---|
| Unreal Engine | 5.0 – 5.8 | el rango declarado en el `.uplugin` del plugin |
| UnrealAgentLink | el plugin de C++ en sí | copiarlo en el `Plugins/` del proyecto |
| Node.js | `^22.19.0 \|\| >=24.0.0` | consultar `engines` en `package.json` |
| Runtime de DSH | cualquier instalación funcional | este plugin se carga como bundle |

**No necesitas la aplicación de escritorio UEBox.** Es otro cliente del mismo proveedor que por casualidad también usa el puerto 17860, así que ejecutar ambos a la vez es un conflicto de puertos. Consulta [README § «No necesita UEBox»](../readme/README_es.md#no-necesita-uebox).

**Tampoco necesitas Unreal Engine** si lo único que quieres es ver funcionar este plugin. UEBox se conecta *hacia fuera* a este puente, así que un editor falso no es más que un cliente WebSocket que responde:

```bash
npm run smoke     # servicio real + editor falso: llama a las 12 herramientas, valida cada resultado
npm run mock:ue   # solo el editor falso, para hurgar a mano
```

`tools/mock-ue-editor.mjs` se conecta a `ws://127.0.0.1:17860`, envía `project.info` y `system.heartbeat`, reenvía las líneas `log.entry`, escribe un PNG real para `editor.screenshot` y responde a los 170 métodos catalogados. Todos los pasos de abajo se pueden seguir contra él.

### Instalación de UnrealAgentLink en un proyecto de UE

1. Copia todo el directorio `UnrealAgentLink` en el `Plugins/` del proyecto (o en el `Plugins/` del motor para una instalación global).
2. Regenera los archivos del proyecto y ábrelo.
3. Confirma que UnrealAgentLink está habilitado en **Edit → Plugins**.

El plugin habilita automáticamente sus dos dependencias distribuidas con el motor, `IKRig` y `PythonScriptPlugin` (ver el `.uplugin`). Una vez que arranca el editor, empieza a conectarse al 17860 sin ninguna configuración.

> Si el puerto está ocupado (por ejemplo por la aplicación de escritorio UEBox), dale al editor uno distinto:
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`
> y cambia la configuración `port` de este lado para que coincida.

---

## 3. Instalación de este plugin

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck + 189 tests + catalog reconciliation, one command
```

`npm run check` debe estar completamente en verde antes de continuar. Verifica tres cosas: que las fuentes y las pruebas pasan la comprobación de tipos, que todas las pruebas de comportamiento pasan, y que el catálogo de 170 comandos coincide con el registro de C++ entrada por entrada.

### Instalación como bundle de DSH

`package.json` declara `dsh.bundle.patch: ./cordis.patch.yml`, y ese archivo hace una sola cosa:

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

**Nota**: en las capas de configuración de DSH, una capa posterior **reemplaza** el `config` de esta fila por completo en lugar de fusionarlo en profundidad. Para sobrescribir cualquier clave hay que reescribir todas las que quieras conservar.

#### Con el script de instalación

DSH no distribuye ningún comando que instale un plugin local fuera del árbol, así que este repositorio incluye uno:

```bash
npm run status:dsh -- --profile web   # what is registered right now (npm passthrough)
node scripts/install-dsh-plugin.mjs --profile web            # mirror, edit the manifest, install, verify
```

Se niega a tocar un manifiesto que una DSH en ejecución todavía retiene, y demuestra que la capa está compuesta antes de informar del éxito — con `--dump-config` en todas partes salvo en el perfil `desktop`, que la CLI no compondrá, así que `dsh plugin --profile desktop list` hace sus veces. Si la guarda de dependencias entre pares detiene la instalación, imprime el comando exacto para aceptar el riesgo — **esa decisión es tuya, no la del script**.

#### A mano

El mecanismo subyacente son cuatro pasos, donde `<profile>` es `web` (o `desktop`, consulta la nota de abajo):

```bash
npm run build    # the mirror ships lib/, and a mirror made before the build is a partial plugin
cp -r lib cordis.patch.yml package.json LICENSE README.md "$DSH_HOME/profiles/<profile>/.vendor/"
dsh plugin --profile <profile> install
dsh --profile <profile> --dump-config | grep -A2 '# == dsh-unreal-agentlink'
```

más dos entradas en `<profile>/package.json`:

```json
"dependencies": { "dsh-unreal-agentlink": "file:C:/Users/you/.dsh/profiles/web/.vendor" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-unreal-agentlink"] } }
```

Ambas son obligatorias y fallan de forma distinta: un paquete listado que no declara `dsh.bundle` falla **ruidosamente** al arrancar, mientras que un paquete instalado que no está listado no aporta **ninguna capa**. Y `file:` debe apuntar a una copia, no a tu espacio de trabajo — pnpm copia lo que encuentra en el momento de la instalación, así que un archivo fuente guardado a medias se convierte en el plugin que DSH carga.

El perfil `desktop` sigue los mismos cuatro pasos, menos el último: `dsh --profile desktop …` se rechaza (`bin.js:112` rechaza el perfil de Electron), mientras que `dsh plugin --profile desktop …` está deliberadamente exento (`bin.js:119`) y es la ruta que usa la propia CLI que lleva Desktop. Así que cierra primero la aplicación — el propio mensaje del producto pide exactamente eso, porque una aplicación en ejecución reescribe el manifiesto desde su lista de plugins en memoria — luego ejecuta la instalación y demuéstrala con `dsh plugin --profile desktop list` en lugar del paso 4.

Si es un agente de IA quien hace la instalación, entrégale en su lugar [INSTALL-ai.md](INSTALL-ai.md) — es el mismo procedimiento escrito como una lista de comprobaciones que puede leer y verificar.

---

## 4. Primera conexión

### Paso 1: confirmar que el puente está vivo

Pide al agente que llame a `ual_status`. Fíjate en cuatro campos:

- `listening: false` → el plugin no arrancó, o el puerto está ocupado. Busca `EADDRINUSE` en el registro de DSH.
- `listening: true` pero `editors: []` → el puente está esperando. Confirma que el proyecto de UE está abierto y que UnrealAgentLink está habilitado.

Durante el **primer instante** después de que un editor se conecta, su registro solo tiene `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale` — campos como `project` aparecen solo una vez que el editor envía `project.info`. Es un estado normal, no un error.

### Paso 2: descubrir la capacidad

No adivines nombres de comandos. Dos pasos:

1. `ual_tools` — busca el comando. Ejemplos de búsqueda por palabra clave:
   ```
   ual_tools { family: "actor" }
   ual_tools { keyword: "screenshot" }
   ```
2. `ual_schema` — mira sus **nombres de clave exactos**, junto con qué claves son obligatorias, si es de larga duración, y qué códigos de estado devuelve. Ejemplo:
   ```
   ual_schema { method: "actor.get" }
   ```

Los nombres de clave de `ual_schema` están **extraídos literalmente** de los handlers de C++. No te saltes este paso: **UE ignora en silencio las claves desconocidas o de tipo incorrecto** — un nombre de clave mal escrito no da error, simplemente «tiene éxito» sin hacer nada.

### Paso 3: la primera llamada real

```
ual_call { method: "editor.ping" }
```

Lectura pura, sin efectos secundarios. Devuelve el `result` del editor **tal cual**; este plugin no lo remodela.

### Paso 4: mirar el nivel

```
ual_screenshot {}
```

Lo que vuelve es una **imagen real** que el agente puede ver directamente. Esto es mejor que `ual_call { method: "editor.screenshot" }`, que solo devuelve una ruta de archivo.

Si `pending_shaders` / `pending_assets` de una captura no son cero, la vista todavía se está compilando o cargando y **no es el aspecto final**. No juzgues que un material está roto a partir de ella.

---

## 5. Flujos de trabajo habituales

### Cambiar una propiedad de un actor

```
ual_call { method: "actor.get", params: { path: "/Game/Maps/Level.Level:PersistentLevel.MyActor" } }
```

Cuando el nombre de una propiedad está mal escrito, el editor **devuelve sugerencias** en lugar de un 404. Lee las sugerencias; no reintentes la escritura incorrecta.

### Operaciones por lotes

Para una secuencia de trabajo conocida, usa `ual_batch` para hacerla en un solo viaje de ida y vuelta:

```
ual_batch { calls: [
  { method: "actor.set_property", params: { ... } },
  { method: "actor.set_property", params: { ... } }
] }
```

- Se ejecuta en serie (el editor ya es serial), y por defecto **se detiene en el primer fallo**; `continueOnError: true` lo cambia.
- Limitado por `maxBatchCalls` (12 por defecto).
- **Si algún elemento es peligroso, todo el lote pasa por aprobación.** El diálogo de aprobación indica de qué elemento se trataba.

### Tareas largas

Los comandos que bloquean el hilo de juego deben pasar por `ual_task`:

```
ual_task { method: "sequence.render", params: { ... } }
```

Devuelve un `jobId` de inmediato y la conversación continúa. Recoge el resultado con `job_output`.

Cuáles son largos: `sequence.render`, `cpp.compile`, `level.build`, `blueprint.compile_all`, `pcg.execute`, `pie.run`, las importaciones de assets. La columna de tiempo de espera de `ual_schema` los marca como "blocking".

**No** sondees el editor mientras se ejecuta una tarea larga — no responderá.

### Reversión

UnrealAgentLink mantiene **una pila de deshacer de agente independiente por editor**, separada del historial de Ctrl+Z del usuario. Este plugin registra a qué sesión de DSH pertenece cada paso y **revierte solo cuando los pasos de esta sesión forman un sufijo LIFO limpio del búfer**. Si otra sesión ha tocado el editor mientras tanto, la herramienta **no deshace nada** e informa de ambas listas de pasos en lugar de descartar en silencio el trabajo de otra persona.

```
ual_undo {}
ual_undo_history {}
```

### Reclamar bloqueos de assets

Antes de un cambio de varios pasos en un asset:

```
ual_locks { add: [{ path: "/Game/Materials/M_Red" }] }
```

El editor dibuja una insignia de "AI is editing" en el navegador de contenido, y se advierte al usuario si empieza a editarlo a mano. Las reclamaciones de varias sesiones las fusiona este plugin en una sola tabla antes de enviarlas, y se reenvían cuando un editor se reconecta.

### Leer los registros

El anillo de registros está vacío por defecto — el reenvío de registros del lado de UE está **desactivado por defecto** y requiere ejecutar `ual.ForwardLogs 1` dentro del editor (este plugin no puede activarlo de forma remota). `ual_logs` lo indica cuando no devuelve nada.

Con el reenvío desactivado, usa en su lugar el registro de mensajes del propio motor. Es un **árbol de categorías**, no una lista plana: pregunta primero qué categorías contiene, y luego pide las líneas dentro de una.

```
ual_logs { pullMessageLog: true }                     # las categorías que tiene el motor
ual_logs { pullMessageLog: true, category: "PIE" }    # las líneas dentro de una
```

La primera forma llama a `messagelog.list`, que **no toma ningún parámetro** y responde con `{categories: [{name, label}]}` — así que puede decirte que una categoría existe, nunca lo que dijo. Las líneas vienen de `messagelog.get`, que necesita una `category`; eso es lo que llama la segunda forma. Ambas son accesibles a través de `ual_call` si quieres la carga útil en bruto.

---

## 6. Interpretar los fallos

Este plugin **nunca analiza el texto de los errores** (el texto alterna entre chino e inglés según la cultura del editor). Los clasifica solo por **nombre de clase de error y código de estado**, en 16 clases.

| clase | Significado | Qué hacer |
|---|---|---|
| `no-editor` | no hay ningún editor conectado | abre el proyecto de UE; confirma que el plugin está habilitado |
| `timeout` | se agotó el tiempo de espera, **el comando puede seguir ejecutándose** | **no lo reenvíes**. Confirma primero el estado real con un comando de lectura |
| `editor-lost` | el editor se desconectó | espera a su reconexión de 5 segundos |
| `queue-stalled` | un comando anterior agotó el tiempo de espera | comprueba `orphaned` en `ual_status` |
| `circuit-open` | fallos de transporte repetidos abrieron el disyuntor | detente, espera el enfriamiento, comprueba `ual_status` |
| `rate-limited` | la cola de limitación de tasa está llena | reduce la velocidad |
| `not-found` | no existe ese método o asset | usa `ual_tools` para encontrar el nombre real del comando |
| `bad-params` | falta un parámetro o está mal tipado | comprueba los nombres de clave con `ual_schema` |
| `precondition` | una precondición falló (412/413/422) | lee `details`; 422 significa «entrada válida pero no se escribió nada» |
| `registry-busy` | el registro de assets todavía está escaneando | sondea `content.registry_status` |
| `unsupported` | esta versión del editor no lo admite | p. ej. `anim.*` necesita UE 5.5+ |
| `engine-error` | el propio editor falló | lee `result.message` (para humanos) y `details` (para máquinas) |

**El tiempo de espera es la clase que más disciplina necesita.** El protocolo no tiene cancelación, así que un tiempo de espera solo significa «este plugin dejó de esperar» — lo más probable es que el comando siga ejecutándose en el hilo de juego. La respuesta correcta es: comprobar `orphaned` en `ual_status`, luego verificar el estado real con un comando de solo lectura, y **no reenviar**.

---

## 7. Configuración

Todas las claves se pueden cambiar, y los valores predeterminados son «vivos pero perezosos». La tabla completa está en [README § Configuración](../readme/README_es.md#configuración). Algunas que merecen atención:

- **`port`** — cámbialo aquí y el lado de UE también necesitará `-UALServer=`.
- **`rateLimitRps: 0`** — desactiva la limitación de tasa.
- **`rollbackOnDispose: false`** — **no** deshace automáticamente cuando termina una sesión. Activarlo significa reversión al desechar, que normalmente es una sorpresa que el usuario no pidió.
- **`logForwardingEnabled: false`** — pásalo a `true` solo después de ejecutar `ual.ForwardLogs 1` dentro del editor.

---

## 8. Solución de problemas

**`ual_status` muestra `listening: true` pero no hay ningún editor**

El proyecto de UE no está abierto, o UnrealAgentLink no está habilitado. También puedes comprobar `LogUALNetwork` en el registro del editor: normalmente deberías ver `Connecting to ws://127.0.0.1:17860` y `Connected to`.

**`EADDRINUSE` al arrancar**

El puerto 17860 está ocupado. La mayoría de las veces por la aplicación de escritorio UEBox. Ciérrala, o mueve tanto el editor como este plugin a otro puerto.

**Todos los comandos devuelven `unknown-method` o se rechazan directamente**

Este plugin solo deja pasar los 170 comandos que existen de verdad en su catálogo. Usa `ual_tools` para confirmar el nombre. Los comandos obsoletos (como `editor.play`, `take_screenshot`) devuelven el reemplazo que hay que usar.

**Las capturas de pantalla salen negras o a medio hacer**

Comprueba `pending_shaders` / `pending_assets`. Un valor distinto de cero significa que la compilación o la carga no ha terminado. Sube `warmup_frames` y reinténtalo.

**`ual_undo` se niega a ejecutarse**

Los pasos de esta sesión no son un sufijo LIFO limpio del búfer — otra sesión tocó el editor mientras tanto. Es una **protección deliberada**, no un error. Usa `ual_undo_history` para ver el contenido real.

**Un cambio de configuración no tuvo efecto**

Las capas de configuración de DSH **reemplazan** el `config` de esa fila por completo en lugar de fusionarlo en profundidad. Debes escribir todas las claves que quieras conservar.

**`ual_task` mató el trabajo pero el editor sigue ocupado**

Esperado. El protocolo no tiene cancelación. Espera a que termine — o, más práctico, no envíes otros comandos mientras se ejecuta una tarea larga.

---

## 9. Próximos pasos

- [Referencia del protocolo](02-protocol.md) — formas de los mensajes, eventos, códigos de estado
- [Arquitectura](03-architecture.md) — el razonamiento detrás de la cadena de compuertas, el aislamiento de sesión y la traducción de errores
- [Referencia de comandos](command-reference.md) — parámetros completos y claves de resultado de los 170 comandos (generado)
