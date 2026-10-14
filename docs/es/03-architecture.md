<div align="center">

[English](../03-architecture.md) · [简体中文](../zh/03-architecture.md) · [繁體中文](../zh-TW/03-architecture.md) · [日本語](../ja/03-architecture.md) · [한국어](../ko/03-architecture.md) · [Deutsch](../de/03-architecture.md) · **Español** · [Français](../fr/03-architecture.md) · [Русский](../ru/03-architecture.md)

[README](../readme/README_es.md) · [Tutorial](01-tutorial.md) · [Protocolo](02-protocol.md) · **Arquitectura** · [Referencia de comandos](command-reference.md)

</div>

# Arquitectura

Este plugin es un **puente puro**: no planifica tareas ni decide qué hacer. Traduce la intención de un agente de DSH en comandos de UnrealAgentLink, y las respuestas del editor en una forma que un agente pueda usar. La planificación pertenece al agente de DSH, no a aquí.

Esta sección explica por qué el código tiene el aspecto que tiene.

---

## 1. Mapa de módulos

```
src/
  index.ts                  Cordis lifecycle, approval gate, dispose-time rollback
  config.ts                 Schemastery schema (the single source of default values)
  service.ts                call() gate chain: catalog → requires → read cache → breaker → rate limit → send → ledger → translate
  protocol/bridge.ts        WebSocket server, send queues, timeouts, orphans, log ring
  protocol/serialization.ts outbound value validation
  protocol/types.ts         wire types, UAL_CODES
  catalog/methods.ts        catalog query: riskOf() / isKnown() / listTools()
  catalog/method-data.ts    GENERATED: parameters, requires, risk, docs for 170 commands
  catalog/method-overrides.ts   entries requiring manual tweaks
  errors/translate.ts       status code / class name → 16 kinds
  resilience/breaker.ts     rate limiter + circuit breaker
  sessions/state.ts         session ledger, LIFO test, lock merging, read cache, log filtering
  tools/*.ts                the 12 tools
tests/                      7 test files, 154 tests
```

### Dirección de las dependencias

```
tools → service → protocol ──► editor
              ├→ catalog
              ├→ errors
              ├→ resilience
              └→ sessions
```

Ninguna capa vuelve atrás. `tools/` nunca habla con `protocol/` directamente; todo pasa por `service.call()`.

---

## 2. La cadena de compuertas: service.call()

**Cada** comando pasa por este único punto de entrada (`src/service.ts:190-332`), en un orden fijo:

```
0. check the 170-command catalog — unknown → refuse (not-found)
1. check the requires table — missing/extra keys → refuse (bad-params)
2. read cache — hit → return directly
3. check the breaker — open → refuse (circuit-open)
4. rate limit — over the cap → refuse (rate-limited)
5. send — no editor → refuse (no-editor)
6. wait for the response — no reply → timeout
7. write the ledger (undo steps, locks)
8. translate the result
```

El valor de los dos primeros pasos es que **rechazan antes de que el motor vea la llamada**. UE ignora en silencio las claves desconocidas, así que un nombre de clave mal escrito hace que una llamada «tenga éxito» sin hacer nada — mucho más difícil de depurar que un error.

`call()` **nunca lanza excepción**. Cada fallo vuelve como `ok: false` dentro de `CallOutcome.value`. Es deliberado: cada rama de la capa de herramientas necesita renderizar un resultado estructurado en lugar de que cada una haga su propio try/catch.

### Por qué los dos primeros pasos deben ser "catálogo", no "tabla de riesgos"

`riskOf()` devuelve `'dangerous'` para un método **desconocido** (un valor predeterminado conservador). Una versión anterior lo usaba para deducir «¿existe este método?», lo cual:

- rechazaba falsamente 5 métodos que sí existen de verdad (`level.new`, `level.open`, `level.save`, `content.migrate`, `blueprint.import_t3d`)
- mientras dejaba pasar cualquier nombre inventado de `editor.*`

La pregunta ahora es `isKnown()` (una consulta al catálogo), no `riskOf()`. **La existencia es una pregunta de catálogo, no una pregunta de riesgo.**

---

## 3. Aislamiento de sesión y reversión

### El problema

UnrealAgentLink mantiene **una pila de deshacer de agente por editor**, compartida por todas las sesiones de DSH. Del lado de DSH, varias sesiones pueden estar controlando el mismo editor a la vez.

Así que «deshacer lo que hizo mi sesión» no es una operación que el protocolo admita.

### El enfoque

`src/sessions/state.ts` registra cada paso que dio cada sesión y les da un **número creciente global** (`global`). Antes de revertir, comprueba si los pasos de esta sesión forman un **sufijo LIFO limpio** del búfer de ese editor — es decir, si el último paso de esta sesión es posterior al último paso de todas las demás sesiones.

```ts
// this session's steps are a LIFO suffix
const isLifoSuffix = sessionLast > otherSessionsLast;
if (!isLifoSuffix) {
  return { undone: 0, blockedBy: otherSessions };
}
```

Mejor negarse que descartar en silencio el trabajo de otra persona.

### `rollbackOnDispose` es `false` por defecto

Revertir automáticamente cuando se desecha una sesión suena conveniente, pero **el usuario nunca lo pidió**. Está desactivado por defecto; activarlo es una declaración explícita de que «el fin de la sesión debe deshacer su trabajo».

---

## 4. Traducción de errores: por qué no lee el texto

El texto de error alterna entre chino e inglés según la cultura del editor (`result.message`). Analizarlo ataría el plugin a un idioma, y el texto puede cambiar en cualquier momento.

`src/errors/translate.ts` clasifica solo por **nombre de clase de error** (`NoEditorError`, `BridgeTimeoutError`, …) y **código de estado**, en 16 clases, y para cada una da una sugerencia sobre qué hacer a continuación.

El orden es: primero el nombre de clase, luego el código de estado. Entre los códigos de estado, `410` mapea a `not-found`, `422` a `precondition`, y `504` a `timeout` — ninguno de estos mapeos es obvio, y por eso la comprobación 4 de `scripts/check-catalog.mjs` consulta el código fuente de C++ para garantizar una cobertura completa.

**Por qué una clasificación que falta es dañina**: el valor de reserva `engine-error` dice «los parámetros están bien, el propio editor está roto». Así que un código sin clasificar apunta al modelo exactamente en la dirección equivocada. El ejemplo más claro es `422` — realmente significa «la entrada era válida pero no se escribió nada», que no se parece en nada a «el editor está roto».

---

## 5. Disyuntor y limitador de tasa

### El disyuntor protege al editor

`src/resilience/breaker.ts`. La decisión clave: **los 4xx se registran como `input` y no disparan el disyuntor.**

El razonamiento: un agente que hace diez llamadas incorrectas seguidas está **trabajando**, no matando al editor. Solo los fallos repetidos de **transporte** significan que el editor en sí está en problemas.

### El limitador de tasa corrigió un error real

El limitador de ventana deslizante originalmente dejaba pasar **al primer llamante en cola de inmediato** — así que la segunda llamada de una ráfaga pasaba al instante y el límite no hacía nada. La corrección está en `breaker.ts:schedule()`: la primera liberación espera el intervalo restante en lugar de disparar de inmediato.

---

## 6. El anillo de registros

El editor envía `log.entry` (lo que requiere `ual.ForwardLogs 1` dentro del editor, que este plugin no puede activar de forma remota).

`bridge.ts` mantiene un anillo de capacidad 512: filtrado por nivel mínimo (predeterminado `Display`), ordenado por severidad, paginado mediante `sinceSeq`, con filtrado de categoría y texto sin distinguir mayúsculas y minúsculas.

**Por qué hacerlo localmente**: reenviar cada línea de registro directamente al modelo ahogaría su contexto. Un anillo más filtrado deja que el agente saque lo que necesita en lugar de que se le empuje todo.

---

## 7. Trabajo largo: ual_task

El protocolo **no tiene semántica de cancelación**. `ual_task` envuelve una llamada larga en un trabajo real de DSH (tipo `ual`) para que la conversación pueda continuar.

Dos cosas deben escribirse en la descripción de la herramienta, o el modelo seguramente malinterpretará:

1. **Matar el trabajo solo detiene la espera de este plugin.** El motor sigue funcionando y el resultado sigue llegando.
2. **Mientras se ejecuta un comando bloqueante, el editor no responde nada** — ni siquiera `sequence.render_status`. Así que no sondees mientras se ejecuta una tarea larga.

---

## 8. La superficie de herramientas: 12, no 170

Si cada uno de los 170 comandos fuera su propia herramienta, 170 esquemas se comerían el prompt de cada solicitud — y la abrumadora mayoría de las solicitudes no usa ninguno de ellos.

Así que:

- `ual_tools` lista la capacidad (filtrable por familia o palabra clave)
- `ual_schema` da los nombres de clave exactos de un comando
- `ual_call` ejecuta

**Descubrir la capacidad toma dos pasos, no cero.** Es un compromiso deliberado: un viaje de ida y vuelta extra a cambio de 170 esquemas menos por solicitud.

---

## 9. Archivos generados y «tablas que nadie importa»

Una clase de defecto se repite en este proyecto y merece su propia nota: **se construye una tabla mantenida a mano, pero nadie la importa.**

Instancias hasta ahora:

| Tabla | Síntoma |
|---|---|
| `REQUIRED_KEYS` | la validación de claves obligatorias era código muerto, y `ual_schema` nunca mostraba `REQUIRED:` |
| `EXTRA_PARAM_KEYS` | los 4 métodos `PARAMS_UNRESOLVED` tenían listas de parámetros vacías |
| `UAL_CODES` | `410`/`422`/`504` quedaban sin clasificar y caían en el engañoso `engine-error` |

El hilo común: la tabla en sí era correcta, estaba documentada y revisada — pero el tiempo de ejecución leía una ruta distinta.

La contramedida es hacer que cada verificación **pregunte a la fuente** en lugar de preguntarle a la tabla:

- comprobación 3 de `check-catalog.mjs`: cada clave `requires` debe ser un literal que aparece en el código fuente de C++
- comprobación 4 de `check-catalog.mjs`: `UAL_CODES` debe coincidir con el conjunto de códigos que el C++ realmente envía (incluidas las compuertas compartidas y las formas de expresión como `Code = bOk ? 200 : 207`)
- `gen-docs.mjs --check`: la referencia de comandos debe coincidir con el catálogo

Todas son verificaciones **no autojustificables**: rompe la fuente o rompe la tabla y falla cualquiera de los dos lados.

---

## 10. Dos trampas reales de seguridad de tipos

### Las propiedades `undefined` explotan

dsh-tools ejecuta una canalización de **dos etapas** al despachar el resultado de una herramienta:

1. `snapshotJsonValue(value)` — lanza `value is not lossless JSON` si **cualquier** propiedad propia es `undefined`
2. `validateJsonSchemaValue(schema, value)` — valida contra el esquema

La primera etapa es más estricta que el esquema y **se ejecuta primero**, así que una prueba que solo comprueba el esquema no puede detectar esta clase de error.

El síntoma real: en el **instante** en que un editor se conecta y antes de que haya enviado `project.info`, su registro de `ual_status` tenía claves como `project: undefined` — así que «la herramienta que lees primero» lanzaba excepción en el momento en que aparecía un editor.

La corrección es la propagación condicional en lugar de escribir `undefined`:

```ts
// wrong
const record = { project: editor.project, version: editor.version };

// right
const record = {
  ...(editor.project && { project: editor.project }),
  ...(editor.version && { version: editor.version }),
};
```

### El esquema de salida debe declarar todas las claves

El esquema de salida de una herramienta usa `additionalProperties: false`, y el registro lo valida **clave por clave**. Así que el `attachment` que devuelve `ual_screenshot` debe declararse en el esquema — si no, lanza `ToolOutputError` **en el momento en que una captura tiene éxito**, mientras que la ruta de texto funciona bien.

El lenguaje de esquemas no tiene un nodo `ImageAttachmentRef`, así que solo puede declararse `{ type: 'json' }`. Eso ensancha el tipo inferido a `JsonValue`, así que la ruta de renderizado debe estrecharlo de nuevo con una **guardia en tiempo de ejecución** en lugar de una aserción `as`:

```ts
function isImageAttachment(value: JsonValue): value is ImageAttachmentRef {
  return !!value && typeof value === 'object' && (value as any).kind === 'image';
}
```

El compilador rechaza un `as` simple aquí (TS2352: los dos tipos no se solapan lo suficiente) — es él exigiendo una comprobación en tiempo de ejecución, no siendo difícil.

---

## 11. Estrategia de verificación

```
service.call() outcome ──┐
                         ├── judge() ── kind ──► translate.ts ──► structured error
socket receives a response ┘
```

lo cual equivale a:

```ts
if (!outcome.ok) throw toUalError(outcome.value);
```

Las pruebas viven en 7 archivos, divididos por **el tipo de defecto que pueden detectar**:

| Archivo | Cubre |
|---|---|
| `protocol.test.ts` | el contrato de `judge()`, las reglas de serialización |
| `translate.test.ts` | clasificación y sugerencias para las 16 clases |
| `resilience.test.ts` | la máquina de estados del disyuntor, el encolado del limitador de tasa, `notifierFor` |
| `catalog.test.ts` | consultas al catálogo, protección de la cadena de prototipos, la compuerta de aprobación de extremo a extremo |
| `bridge.test.ts` | un WebSocket real: colas, huérfanos por tiempo de espera, eventos, apagado |
| `tool-output.test.ts` | el valor de retorno real de cada herramienta a través de la canalización de dos etapas |
| `end-to-end.test.ts` | la cadena de compuertas real + un socket real + esquemas de herramientas reales |

**Por qué `end-to-end.test.ts` tiene que existir**: todas las demás pruebas sustituyen una capa. El error de `REQUIRED_KEYS` — generado, documentado, revisado, nunca importado — no lo detectó ninguna prueba unitaria, porque cada capa era autoconsistente de forma aislada. Solo cablear la cadena de compuertas real a un socket real y alimentarla con un esquema real expone **la costura entre capas**.

Por la misma razón, `tool-output.test.ts` usa el **real** `snapshotJsonValue` + `validateJsonSchemaValue` en lugar de escribir su propia comprobación de esquema — si no, el defecto del `undefined` de `ual_status` se colaría igual.

---

## 12. Configuración

El esquema de Schemastery en `src/config.ts` es **la fuente única de valores predeterminados**. El `config` en `cordis.patch.yml` simplemente reafirma valores predeterminados que el esquema ya tiene.

**Nota sobre las capas de configuración de DSH**: una capa posterior **reemplaza** el `config` de esa fila por completo en lugar de fusionarlo en profundidad. Para sobrescribir cualquier clave hay que reescribir todas las que quieras conservar.

Interruptores como `allowDangerous` **deliberadamente no existen** — la compuerta de riesgo pasa por la costura de aprobación nativa `tools/pre-execute` de DSH en lugar de que el plugin invente su propio bypass.

---

## 13. Degradación ante dependencias opcionales

`cordis.patch.yml` declara exactamente una dependencia dura: el registro de `tools` (mediante `inject`). Todo lo demás se lee mediante `ctx.get`:

| Servicio | Cuando falta |
|---|---|
| `jobs` | `ual_task` devuelve `kind:'background'` y explica que no está disponible |
| `fs` / `attachments` | las capturas de pantalla degradan a una ruta de texto más la razón |
| `agents` | la conexión/desconexión del editor no notifica al agente |
| `approval` | `ask` se convierte en un rechazo por parte de DSH |

De este modo, una composición que omite un servicio **pierde una funcionalidad** en lugar de fallar al cargar.
