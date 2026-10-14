<div align="center">

**English** · [简体中文](zh/03-architecture.md) · [繁體中文](zh-TW/03-architecture.md) · [日本語](ja/03-architecture.md) · [한국어](ko/03-architecture.md) · [Deutsch](de/03-architecture.md) · [Español](es/03-architecture.md) · [Français](fr/03-architecture.md) · [Русский](ru/03-architecture.md)

[README](../README.md) · [Tutorial](01-tutorial.md) · [Protocol](02-protocol.md) · **Architecture** · [Command reference](command-reference.md)

</div>

# Architecture

This plugin is a **pure bridge**: it does not plan tasks or decide what to do. It translates a DSH agent's intent into UnrealAgentLink commands and the editor's answers back into a shape an agent can use. Planning belongs to DSH's agent, not here.

This section explains why the code looks the way it does.

---

## 1. Module map

```
src/
  index.ts          Cordis lifecycle, approval gate, dispose-time rollback
  config.ts         Schemastery schema (the single source of default values)
  service.ts        call() gate chain — the one entry point for every command
  protocol/
    bridge.ts       WebSocket server: connections, queues, timeouts, orphans, log ring
    serialization.ts  outbound parameter validation (stricter than JSON.stringify)
    types.ts        wire types and UAL_CODES
  catalog/
    method-data.ts      five tables extracted from C++ (generated, do not hand-edit)
    method-overrides.ts  manual patches where the extractor cannot reach
    methods.ts          170 commands with risk tier and summary + query functions
  errors/translate.ts   error classification (by class name / status code, not by text)
  resilience/breaker.ts rate limiter + circuit breaker
  sessions/state.ts     session ledger, LIFO test, lock merging, cache, log filtering
  tools/                the 12 tools
scripts/
  extract-methods.mjs   extracts the catalog from the C++ (generates method-data.ts)
  check-catalog.mjs     reconciles catalog against the C++ registry, both directions
  gen-docs.mjs          renders docs/<lang>/command-reference.md for all 9 languages
  languages.mjs         the language set — shared by the generator and the docs tests
  normalize-doc-headers.mjs  rewrites the language bars and doc-nav lines from the language set
  normalize-doc-links.mjs    rewrites body links so they resolve from the file they sit in
docs/                   tutorial / protocol / architecture / command reference, ×9 languages
tests/                  162 tests in 8 files
```

### Dependency direction

```
index.ts ──► service.ts ──► protocol/bridge.ts
    │            │
    │            ├──► catalog/methods.ts ──► catalog/method-data.ts
    │            ├──► resilience/breaker.ts
    │            ├──► sessions/state.ts
    │            └──► errors/translate.ts
    └──► tools/* ──► service.ts
```

There are no reverse dependencies. `tools/` depends only on `service`, and `service` depends on no tool.

---

## 2. The gate chain: `service.call()`

**Every** command goes through this one entry point (`src/service.ts:190-332`), in a fixed order:

```
1. catalog gate    the method is not in the catalog → refuse, never forward
2. requires gate   a required key is missing → refuse, never forward
3. read cache      read-only + cacheable + not long → return, never touch the socket
4. breaker         acquire() throws when open / admit() lets exactly one half-open probe
5. rate limit      throws when the queue is full
6. send            bridge.send() → the editor
7. judge()         200/207 plus result.ok/error decides success
8. ledger          recorded only when the call both mutates and succeeds
9. translate       on failure, classify by class name / status code
   finally         breaker.release()
```

The value of the first two steps is that they **refuse before the engine ever sees the call**. UE silently ignores unknown keys, so a misspelled key name makes a call "succeed" at doing nothing — far harder to debug than an error.

`call()` **never throws**. Every failure comes back as `ok: false` inside `CallOutcome.value`. This is deliberate: every branch of the tool layer needs to render a structured result rather than each doing its own try/catch.

### Why the first two steps must be "catalog", not "risk table"

`riskOf()` returns `'dangerous'` for an **unknown** method (a conservative default). An earlier version used it to infer "does this method exist", which:

- falsely refused 5 methods that really do exist (`level.new`, `level.open`, `level.save`, `content.migrate`, `blueprint.import_t3d`)
- while letting through any invented `editor.*` name

The question is now `isKnown()` (a catalog lookup), not `riskOf()`. **Existence is a catalog question, not a risk question.**

---

## 3. Session isolation and rollback

### The problem

UnrealAgentLink maintains **one agent undo stack per editor**, shared by every DSH session. On the DSH side, several sessions may be driving the same editor at once.

So "undo what my session did" is not an operation the protocol supports.

### The approach

`src/sessions/state.ts` records every step each session took and gives each a **globally increasing number** (`global`). Before rolling back it checks whether this session's steps form a **clean LIFO suffix** of that editor's buffer — that is, whether this session's last step is later than every other session's last step.

```
yes  → roll back, undoing only this session's steps
no   → undo nothing, and report both step lists
```

Better to refuse than to silently discard someone else's work.

### `rollbackOnDispose` defaults to false

Auto-rolling back when a session is disposed sounds convenient, but **the user never asked for it**. It is off by default; turning it on is an explicit statement that "the session ending should undo its work".

---

## 4. Error translation: why it does not read the text

The error text switches between Chinese and English with editor culture (`result.message`). Parsing it would tie the plugin to one language, and the text can change at any time.

`src/errors/translate.ts` classifies by **error class name** (`NoEditorError`, `BridgeTimeoutError`, …) and **status code** only, into 16 kinds, and for each gives a suggestion about what to do next.

The order is: class name first, then status code. Among status codes, `410` maps to `not-found`, `422` to `precondition`, and `504` to `timeout` — none of these mappings is obvious, which is why check 4 of `scripts/check-catalog.mjs` queries the C++ source to guarantee complete coverage.

**Why a missing classification is harmful**: the fallback `engine-error` says "the parameters are fine, the editor itself is broken". So an unclassified code points the model in exactly the wrong direction. The clearest example is `422` — it really means "the input was valid but nothing was written", which is nothing like "the editor is broken".

---

## 5. Circuit breaker and rate limiter

### The breaker protects the editor

`src/resilience/breaker.ts`. The key decision: **4xx is recorded as `input` and does not trip the breaker.**

The reasoning: an agent making ten bad calls in a row is **working**, not killing the editor. Only repeated **transport** failures mean the editor itself is in trouble.

### The rate limiter fixed a real bug

The sliding-window limiter originally let the **first queued caller through immediately** — so the second call in a burst passed instantly and the limit did nothing. The fix is in `breaker.ts:schedule()`: the first release waits out the remaining interval instead of firing at once.

---

## 6. The log ring

The editor pushes `log.entry` (requiring `ual.ForwardLogs 1` inside the editor, which this plugin cannot turn on remotely).

`bridge.ts` keeps a ring of capacity 512: filtered by minimum level (default `Display`), ordered by severity, paginated via `sinceSeq`, with case-insensitive category/text filtering.

**Why do it locally**: forwarding every log line straight to the model would drown its context. A ring plus filtering lets the agent pull what it needs instead of being pushed everything.

---

## 7. Long work: `ual_task`

The protocol has **no cancellation semantics**. `ual_task` wraps a long call in a real DSH job (kind `ual`) so the conversation can continue.

Two things must be written into the tool description, or the model will certainly misunderstand:

1. **Killing the job only stops this plugin's wait.** The engine keeps running and the result still comes back.
2. **While a blocking command runs, the editor answers nothing** — not even `sequence.render_status`. So do not poll while a long task runs.

---

## 8. The tool surface: 12, not 170

If each of the 170 commands were its own tool, 170 schemas would eat the prompt of every request — and the overwhelming majority of requests use none of them.

So:

- `ual_tools` lists capability (filterable by family or keyword)
- `ual_schema` gives the exact key names for one command
- `ual_call` executes

**Discovering capability takes two steps, not zero.** This is a deliberate tradeoff: one extra round trip in exchange for 170 fewer schemas per request.

---

## 9. Generated files and "tables nobody imports"

One defect class recurs in this project and deserves its own note: **a hand-maintained table is built, but nobody imports it.**

Instances so far:

| Table | Symptom |
|---|---|
| `REQUIRED_KEYS` | required-key validation was dead code, and `ual_schema` never showed `REQUIRED:` |
| `EXTRA_PARAM_KEYS` | the 4 `PARAMS_UNRESOLVED` methods had empty parameter lists |
| `UAL_CODES` | `410`/`422`/`504` were unclassified and fell back to the misleading `engine-error` |

The common thread: the table itself was correct, documented, and reviewed — but the runtime read a different path.

The countermeasure is to make each check **ask the source** rather than ask the table:

- `check-catalog.mjs` check 3: every `requires` key must be a literal that appears in the C++ source
- `check-catalog.mjs` check 4: `UAL_CODES` must match the set of codes the C++ actually sends (including shared gates and expression forms like `Code = bOk ? 200 : 207`)
- `gen-docs.mjs --check`: the command reference must match the catalog
- `i18n.test.ts`: the documentation must be complete and internally consistent — which for a translation means "the links still resolve", and anchors are derived from the *translated* heading, so they break silently

The language set is the newest instance of the shape. `gen-docs.mjs` and `tests/i18n.test.ts` both need to know which languages exist, and while each kept its own copy, adding a language meant finding both by hand — and a language the generator writes but the tests never check is a language nobody verifies. `scripts/languages.mjs` is now the single source, imported by both.

These are all **non-self-justifying** checks: break the source or break the table and either side fails.

---

## 10. Two real type-safety traps

### `undefined` properties blow up

dsh-tools runs a **two-stage** pipeline when dispatching a tool result:

1. `snapshotJsonValue(value)` — throws `value is not lossless JSON` if **any** own property is `undefined`
2. `validateJsonSchemaValue(schema, value)` — validates against the schema

The first stage is stricter than the schema and **runs first**, so a test that only checks the schema cannot catch this class of bug.

The real symptom: the **instant** an editor connects and before it has pushed `project.info`, its `ual_status` record had keys like `project: undefined` — so "the tool you read first" threw the moment an editor appeared.

The fix is conditional spreading rather than writing `undefined`:

```ts
...(session.info?.projectName !== undefined ? { project: session.info.projectName } : {})
```

### The output schema must declare every key

A tool's output schema uses `additionalProperties: false`, and the registry validates it **key by key**. So the `attachment` returned by `ual_screenshot` must be declared in the schema — otherwise it throws `ToolOutputError` **at the moment a screenshot succeeds**, while the text path works fine.

The schema language has no `ImageAttachmentRef` node, so it can only be declared `{ type: 'json' }`. That widens the inferred type to `JsonValue`, so the render path must narrow it back with a **runtime guard** rather than an `as` assertion:

```ts
const attachment = imageRef(record.attachment)   // validates field by field
return attachment ? [{ type: 'image', attachment }, ...blocks] : blocks
```

The compiler refuses a plain `as` here (TS2352: the two types do not sufficiently overlap) — that is it demanding a runtime check, not being difficult.

---

## 11. Verification strategy

```bash
npm run check
```

which is equivalent to:

```bash
tsc -p tsconfig.json --noEmit      # src
tsc -p tsconfig.test.json          # tests (src's tsconfig does not include tests)
vitest run                         # 162 tests
node scripts/check-catalog.mjs     # 4 reconciliation checks
node scripts/gen-docs.mjs --check  # command reference current in 9 languages
node scripts/normalize-doc-headers.mjs --check   # language bars canonical in 45 files
node scripts/normalize-doc-links.mjs --check     # body links resolve from where they sit
```

The tests live in 8 files, divided by **the kind of defect they can find**:

| File | Covers |
|---|---|
| `protocol.test.ts` | the `judge()` contract, serialization rules |
| `translate.test.ts` | classification and hints for all 16 kinds |
| `resilience.test.ts` | the breaker state machine, rate-limit queueing, `notifierFor` |
| `catalog.test.ts` | catalog queries, prototype-chain protection, the approval gate end to end |
| `bridge.test.ts` | a real WebSocket: queues, timeout orphans, events, shutdown |
| `tool-output.test.ts` | every tool's real return value through the two-stage pipeline |
| `i18n.test.ts` | the documentation is complete and internally consistent, in all 9 languages |
| `end-to-end.test.ts` | the real gate chain + a real socket + real tool schemas |

**Why `end-to-end.test.ts` has to exist**: every other test stubs out one layer. The `REQUIRED_KEYS` bug — generated, documented, reviewed, never imported — was caught by no unit test, because each layer was self-consistent in isolation. Only wiring the real gate chain to a real socket and feeding it to a real schema exposes **the seam between layers**.

For the same reason, `tool-output.test.ts` uses the **real** `snapshotJsonValue` + `validateJsonSchemaValue` rather than writing its own schema check — otherwise the `ual_status` `undefined` defect would slip through just the same.

`i18n.test.ts` is here for the same reason and about a different seam. Everything under `src/` knows nothing about `docs/`, so no existing test could notice a translation that forgot a language in its switcher bar or linked to a heading it had renamed. It reads the docs as data instead: every language has the four files, every bar lists all nine languages and bolds exactly its own, every relative link resolves to a real file, and every `#anchor` resolves to a real heading. That last one is the interesting one — anchors are derived from the *translated* heading text, so a translator rewording "Verification strategy" silently invalidates every link into that section, with no error anywhere. `gen-docs.mjs --check` guards the generated command references the same way; `i18n.test.ts` shells out to it rather than re-implementing the render.

The test also caught the two mechanical defects that motivated the two normalizer scripts. Translators write a link the way it reads from the English original, so `docs/readme/README_zh.md` linked `zh/01-tutorial.md` — which resolves to `docs/readme/zh/…` — and the root README had the mirror image, `../docs/01-tutorial.md`. The same class of drift hit the header bars, where the German topic docs linked their own language instead of bolding it. Both bars and links are therefore derived by `normalize-doc-headers.mjs` and `normalize-doc-links.mjs` from `scripts/languages.mjs` plus the file's own translated labels, and both have a `--check` mode wired into `npm run check`, so a hand-written link cannot land again.

---

## 12. Configuration

The Schemastery schema in `src/config.ts` is **the single source of default values**. The `config` in `cordis.patch.yml` merely restates defaults the schema already has.

**Note DSH's configuration layering**: a later layer **replaces** that row's `config` wholesale rather than deep-merging it. To override any key you must rewrite every key you want to keep.

Switches like `allowDangerous` **deliberately do not exist** — the risk gate goes through DSH's native `tools/pre-execute` approval seam rather than the plugin inventing a bypass of its own.

---

## 13. Degrading on optional dependencies

`cordis.patch.yml` declares exactly one hard dependency: the `tools` registry (via `inject`). Everything else is read through `ctx.get`:

| Service | When missing |
|---|---|
| `jobs` | `ual_task` returns `kind:'background'` and explains it is unavailable |
| `fs` / `attachments` | screenshots degrade to a text path plus the reason |
| `agents` | editor connect/disconnect does not notify the agent |
| `approval` | `ask` is turned into a refusal by DSH |

This way a composition that omits one service **loses one feature** rather than failing to load.
