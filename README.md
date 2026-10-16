<div align="center">

**English** · [简体中文](docs/readme/README_zh.md) · [繁體中文](docs/readme/README_zh-TW.md) · [日本語](docs/readme/README_ja.md) · [한국어](docs/readme/README_ko.md) · [Deutsch](docs/readme/README_de.md) · [Español](docs/readme/README_es.md) · [Français](docs/readme/README_fr.md) · [Русский](docs/readme/README_ru.md)

# dsh-unreal-agentlink

### A DSH plugin that puts your Unreal Editor under your agent.

**Pure bridge. The agent plans; this plugin only translates.**

```
DSH agent  ──tool calls──►  dsh-unreal-agentlink  ◄──WebSocket──  Unreal Editor
(plans, decides)            (this plugin: server, translator)   editor dials out
```

[Installation](#installation) · [Requirements](#requirements) · [12 tools](#12-tools) · [Configuration](#configuration) · [Documentation](#documentation)

<code>npm install &amp;&amp; npm run check</code>

</div>

---

Your agent can already read files and run commands. This plugin gives it the editor itself: query the level, spawn actors, edit blueprints and materials, render sequences, take screenshots it can actually *see*, and roll its own work back when something goes wrong.

It does **not** plan tasks. Planning belongs to DSH's native agent. This plugin is a translator with a safety layer — it turns agent intent into UnrealAgentLink commands and turns the editor's answers back into something an agent can act on.

---

## Installation

Three parts: put the UnrealAgentLink C++ plugin into your UE project, install this plugin into DSH, and open the editor. That is all — **no UEBox, no token, no handshake**.

### Step 1 — install UnrealAgentLink into the UE project

1. Copy the whole `UnrealAgentLink` directory into your project's `Plugins/` (or the engine's `Plugins/` for a global install).
2. Regenerate project files, then open the project.
3. Confirm UnrealAgentLink is enabled under **Edit → Plugins**. It pulls in two engine-shipped dependencies, `IKRig` and `PythonScriptPlugin`, automatically.

From then on the editor dials out on its own: `StartupModule` unconditionally calls `Init("ws://127.0.0.1:17860")` and retries every 5 seconds, so **startup order does not matter**.

> Port already taken (for example by UEBox)? Give the editor a different one and match it on this side:
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`

### Step 2 — install this plugin into DSH

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck (src + tests) + 189 tests + catalog + doc reconciliation, one command
```

`npm run check` must be fully green before going further — it verifies that sources and tests typecheck, the behaviour tests pass, and the 170-command catalog lines up with the C++ registry entry by entry.

Then register it as a DSH bundle. `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`, and that file does one thing:

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

> **Configuration layering**: a later layer **replaces** that row's `config` wholesale rather than deep-merging it. To override anything, rewrite every key you want to keep.

DSH ships no command that installs a local, out-of-tree plugin, so this repository ships an installer that does the job and then defers to the real one:

```bash
npm run status:dsh -- --profile web     # what is registered right now (same script, npm passthrough)
node scripts/install-dsh-plugin.mjs --profile web             # mirror, edit the manifest, install, verify
```

It refuses to touch a manifest a running DSH still holds, and proves the layer is composed before reporting success: `dsh --profile <profile> --dump-config` must contain `# == dsh-unreal-agentlink`, except on `desktop`, which the CLI will not compose — there the layer is proven through `dsh plugin --profile desktop list`, which reads the same package graph. If the peer-dependency guard stops the install it prints the exact command to accept the risk — **that decision is yours, not the script's**.

Two more paths, both written out: the [manual install](#manual-install-without-the-script) below, and [INSTALL-ai.md](docs/INSTALL-ai.md) — a version an AI agent can read and follow step by step.

### Step 3 — open the project and verify

Open the UE project, then have the agent call `ual_status` and check three fields:

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → the plugin did not start, or the port is taken. Look for `EADDRINUSE` in the DSH log.
- `listening: true` but `editors: []` → the bridge is waiting. Confirm the UE project is open and UnrealAgentLink is enabled.

For the **first instant** after an editor connects its record has only `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`; fields like `project` appear only once the editor pushes `project.info`. That is a normal state, not an error.

Then try a pure read with no side effects:

```
ual_call { method: "level.get_current" }
```

**The full walkthrough — workflows, reading failures, troubleshooting — is in the [tutorial](docs/01-tutorial.md).**

---

## Requirements

| Item | Requirement |
|---|---|
| Unreal Engine | 5.0 – 5.8 |
| UnrealAgentLink | the C++ plugin itself, dropped into your project's `Plugins/` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| DSH runtime | this plugin installed as a bundle |

### You do not need UEBox

The UEBox desktop app is **not a dependency**. It is another client from the same vendor that happens to use port 17860 too, so running both at once is a port conflict — that is the whole relationship. The evidence:

- `UnrealAgentLink.uplugin:25-34` declares exactly two dependencies, both engine-shipped: `IKRig` and `PythonScriptPlugin`. No uebox module.
- Every entry in `UnrealAgentLink.Build.cs` is an engine module (UnrealEd / AssetRegistry / MovieScene / Landscape …). No uebox SDK.
- The string `uebox` appears three times in the entire source, all of them `// Copyright uebox.ai` headers.
- Nothing in the source calls uebox.ai. The only `FHttpModule` use reads the local machine's proxy settings (`UAL_ProxyDiagnostics.cpp:167`).

Once the plugin is in your project it runs on its own: `StartupModule` unconditionally calls `Init("ws://127.0.0.1:17860")` (`Core/UnrealAgentLink.cpp:86-97`), pushes `project.info` the moment it connects, and has no handshake, token, or authentication.

> To move the port: `-UALServer=ws://127.0.0.1:17861` on the editor side, and the `port` setting on this side.

### Manual install without the script

The script above is a convenience; the underlying mechanism is four lines of manifest plus one product command. Where `<profile>` is `web` — `desktop` works too, with the one substitution noted at the end of this section — and `$DSH_HOME` is `~/.dsh` by default:

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

Step 4 is the one step `desktop` cannot run: the CLI refuses to boot that profile from the command line, so prove it with `dsh plugin --profile desktop list` instead (see below).

The two entries, in `<profile>/package.json`:

```json
"dependencies": { "dsh-unreal-agentlink": "file:C:/Users/you/.dsh/profiles/web/.vendor" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-unreal-agentlink"] } }
```

Both are mandatory and they fail differently: a listed package that declares no `dsh.bundle` fails **loud** at boot, while an installed package that is not listed contributes **no layer at all** and nothing appears in `--dump-config`.

**Why `file:` points at a copy, not at your workspace**: pnpm copies what it finds at install time, so a half-saved source file — or a deleted `lib/` after a failed build — becomes the plugin DSH loads. Mirror first, install second.

**The `desktop` profile is a supported target, with one CLI gap.** `dsh --profile desktop …` is refused outright (`bin.js:112`, `rejectElectronProfile`) because the Electron app owns that profile's lifetime — but the guard is deliberately skipped for `dsh plugin` (`bin.js:119`), and the Desktop-carried CLI the app itself calls depends on exactly that (`dsh-desktop-host/lib/cli.js:91-104` passes `manageDesktopProfile: true`). So install into `desktop` as shown above, with two changes: step 4 becomes `dsh plugin --profile desktop list`, and the app must be fully quit first. The product's own message spells that out — *"Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop"* — because a running app rewrites the manifest from its in-memory plugin list, so an edit made underneath it can be lost. Launch Desktop afterwards to mount the layer.

---

## Documentation

| Document | Contents |
|---|---|
| [Tutorial](docs/01-tutorial.md) | End-to-end: install the plugin, get it connected, common workflows, troubleshooting |
| [Protocol reference](docs/02-protocol.md) | Message shapes, events, the 13 status codes, serialization rules, timeout and concurrency semantics |
| [Architecture](docs/03-architecture.md) | The gate chain, session isolation and rollback, error translation, verification strategy, the traps we hit |
| [Command reference](docs/command-reference.md) | Params / required keys / result keys / status codes for all 170 commands (**generated**) |
| [Install guide (AI-readable)](docs/INSTALL-ai.md) | The install procedure written for an AI agent to read and execute, with the checks it must run before and after |

All five exist in every language listed at the top of this file, under `docs/<lang>/` — `en` (canonical, at `docs/` directly), `zh`, `zh-TW`, `ja`, `ko`, `de`, `es`, `fr`, `ru`.

> Only the *prose* is translated. Command names, parameter keys, result keys, status codes, config keys and C++ line references stay verbatim everywhere, because UE silently ignores a key it does not recognize — a translated `asset_path` would be a silently dead key, not a localization. `tests/i18n.test.ts` enforces the invariants that make this maintainable: every language has its files, every switcher bar lists every language, and every internal link and `#anchor` resolves. That last one matters because anchors are derived from the *translated* heading, so rewording a heading silently breaks every link pointing at it.

---

## Four facts to establish first

These are not design choices. They are existing UnrealAgentLink constraints, and they determine how every operation is written.

1. **The direction is reversed.** This plugin does not dial the editor — **the editor dials out**. Startup order does not matter: open the editor first and it retries every 5 seconds until the plugin appears.
2. **There is no authentication.** No token, no header, no subprotocol. **The port is the credential**, so it binds loopback only by default. Do not change it to `0.0.0.0`.
3. **Commands run serially on the game thread.** And while a blocking command runs, **the editor answers nothing** — not even a progress query like `sequence.render_status`.
4. **There is no cancellation.** `query_task` and `cancel_task` do not exist. Killing a `ual_task` job only stops this plugin's wait; the engine keeps going and the result still comes back.

---

## 12 tools

Surfacing 170 commands as 170 tools would spend a large slice of every request's prompt on capabilities a given task never touches. So discovering capability is two steps, not zero:

| Tool | Purpose |
|---|---|
| `ual_status` | Editor connections / breaker / rate limit / session / orphaned commands. **Read this first when anything is wrong** |
| `ual_tools` | List all 170 commands (22 families), filterable by family or keyword |
| `ual_schema` | The **exact key names** for one command — check before calling; UE silently ignores unknown keys |
| `ual_call` | Run one command, return the editor's result verbatim |
| `ual_batch` | Several commands in one round trip (capped by `maxBatchCalls`; one dangerous item puts the whole batch through approval) |
| `ual_screenshot` | Capture and return a **real image** the agent can see |
| `ual_logs` | Read the local log ring (UE-side forwarding is off by default — see the tutorial) |
| `ual_undo` / `ual_undo_history` | Per-session rollback / inspect the undo buffer |
| `ual_locks` | Claim asset locks; the editor draws an "AI is editing" badge |
| `ual_editor_bind` | Pin a session to one editor when several are connected |
| `ual_task` | Turn a long blocking command into a real background job so the conversation continues |

### Risk tiers

read 65 / write 89 / **destructive 2 / dangerous 14** (the last 16 go through approval).

`tools/pre-execute` returns `{kind:'ask'}` for destructive and dangerous methods (including any dangerous item inside a `ual_batch`), leaving the decision to session policy. **An unregistered method is denied outright** and never reaches the editor.

Note that under a `never` policy, `ask` is auto-rejected — which is the correct reading of "unattended sessions must not touch the editor".

---

## Configuration

Defaults are "alive but lazy". The full table with reasoning is in [tutorial §7](docs/01-tutorial.md#7-configuration).

| Key | Default | Meaning |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `17860` | Keep it on loopback: with no auth, reaching the port means driving the editor |
| `timeoutMs` | `180000` | Blocking commands raise their own floors |
| `cacheTtlMs` / `cacheMaxEntries` | `2000` / `128` | Per-session read cache |
| `rateLimitRps` / `rateLimitQueue` | `5` / `32` | Commands per second / queue cap (0 disables rate limiting) |
| `breakerThreshold` / `breakerCooldownMs` | `3` / `30000` | Consecutive transport failures to open / cooldown |
| `logCapacity` / `logMinLevel` | `512` / `Display` | Log ring |
| `logForwardingEnabled` | `false` | Set true only after running `ual.ForwardLogs` inside the editor |
| `rollbackOnDispose` | `false` | Only a LIFO suffix is exact — see the architecture doc |
| `notifyOnEditorChange` | `true` | Inject a line into the agent when an editor connects or drops |
| `screenshotAttachments` / `screenshotMaxBytes` | `true` / 12MB | Image blocks / size cap |
| `maxBatchCalls` | `12` | Per-`ual_batch` cap |

---

## Development

```bash
npm run build       # tsc → lib/
npm run dev         # tsc --watch
npm run check       # typecheck + tests + catalog reconciliation (run before committing)
npm test            # tests only
npm run typecheck   # src and tests typechecked separately
```

### Source layout

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
docs/                       Tutorial / protocol / architecture / command reference / install guide,
                             in 9 languages
tests/                      189 tests
```

### Generated files: do not edit by hand

`src/catalog/method-data.ts` and `docs/<lang>/command-reference.md` are both **generated**:

```bash
node scripts/extract-methods.mjs .ua-ref/plugin/UnrealAgentLink/Source   # rebuild the catalog from C++
npm run build && node scripts/gen-docs.mjs                             # rebuild the command reference (all 9 languages)
```

A hand-maintained table that nobody imports is a recurring defect class in this project (`REQUIRED_KEYS`, `EXTRA_PARAM_KEYS` and `UAL_CODES` have all been caught by it). The countermeasure is to make each check **ask the source** rather than ask the table — see [architecture §9](docs/03-architecture.md#9-generated-files-and-tables-nobody-imports).

### Tests and checks

```bash
npm run check                       # typecheck (src + tests) + 189 passed + catalog + doc reconciliation
npm test                            # 189 passed
node scripts/check-catalog.mjs      # 170/170 zero drift; every requires key appears in C++; code set matches C++
node scripts/gen-docs.mjs --check   # is the command reference up to date in all 9 languages
node scripts/normalize-doc-headers.mjs --check   # are the language bars canonical in all 54 files
node scripts/normalize-doc-links.mjs --check     # do the body links resolve from where they sit
npm run docs                        # regenerate + rewrite the 54 doc headers and links
npm run install:dsh -- --profile web    # register this plugin with a dsh profile (see Installation)
```

The ten test files are divided by **the kind of defect they can find**, each for a reason — see [architecture §11](docs/03-architecture.md#11-verification-strategy).

`requires` is not hand-written: it is derived from the handlers' own `SendError(..., 400, "Missing field: X")` messages (28 sites), because a wrong required key makes the bridge reject a *valid* call before the engine sees it. The result lands in `method-data.ts` as `REQUIRED_KEYS`, and `methods.ts`'s `requiresOf()` merges it into runtime use (the early rejection in `service.call()`, the `REQUIRED:` line in `ual_schema`, and error hints all go through that one function).

It deliberately **narrows only, never widens**: a message containing `or` (`"Missing field: name or path"`) is skipped entirely, and keys harvested from a called function in the same file are dropped as branch-local — see `REQUIRED_DROPPED` in `scripts/extract-methods.mjs`, where every entry cites its C++ line number. So "no keys harvested" is the safe default, not a missed check.

### Test without Unreal Engine

You do not need an editor, or UEBox, to run this plugin — and the seam is the protocol itself: UEBox dials **out** to this bridge, so a fake editor is just a WebSocket client that answers.

```bash
npm run smoke                        # start the real service, dial in a fake editor,
                                     # call all 12 tools, validate every result
npm run smoke -- --out /tmp/ual      # keep the transcript and the PNGs somewhere else
npm run smoke -- --method actor.get  # one catalog method, printed raw
npm run mock:ue                      # just the fake editor, to poke at by hand
```

`tools/mock-ue-editor.mjs` is a real process, not a stub: it dials `ws://127.0.0.1:17860`, pushes `project.info` and `system.heartbeat`, forwards `log.entry` lines, writes a genuine PNG for `editor.screenshot`, and answers **all 170 cataloged methods** — realistic bodies for the families that matter, and a body carrying the documented result keys for the rest. `tools/ual-smoke.mjs` starts the same `UalService` that `apply()` starts, calls every tool through its real `execute`, validates each value against that tool's own output schema, and prints what the model would have seen. It is the manual twin of `tests/mock-editor.test.ts`; both are described in [architecture §11](docs/03-architecture.md#11-verification-strategy).

---

## Protocol essentials

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }     // id is generated by the server
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }        // the key is omitted when empty
UE → plugin:  { ver,       type:"evt", method, payload }
```

- Failure is expressed **by `code` alone**. There is no envelope-level `error` field.
- Human-readable text is in `result.message` (Chinese or English depending on editor culture — **do not parse it**); machine-readable detail is in `result.details`.
- **Many handlers return `200` with `result.ok === false`** (`editor.undo`, `blueprint.compile`, `pie.observe`), so the plugin judges success with `judge()`, not by code alone. There are 55 `SetStringField(TEXT("error"), ...)` sites across 14 C++ files — this is the norm, not an anomaly.
- `content.import_folder` / `content.import_assets` are **fire-and-forget outbound pushes**: no `id`, no reply expected. The plugin turns them into logs and agent notifications and **does not fabricate a `res`** — replying `ok:false` would only show the user a false "import failed" dialog, which is worse than silence.

Full detail (all 13 status codes, serialization rules, timeout semantics) is in the [protocol reference](docs/02-protocol.md).

---

## License

MIT
