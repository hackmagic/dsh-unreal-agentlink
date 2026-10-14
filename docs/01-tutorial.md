<div align="center">

**English** · [简体中文](zh/01-tutorial.md) · [繁體中文](zh-TW/01-tutorial.md) · [日本語](ja/01-tutorial.md) · [한국어](ko/01-tutorial.md) · [Deutsch](de/01-tutorial.md) · [Español](es/01-tutorial.md) · [Français](fr/01-tutorial.md) · [Русский](ru/01-tutorial.md)

[README](../README.md) · **Tutorial** · [Protocol](02-protocol.md) · [Architecture](03-architecture.md) · [Command reference](command-reference.md)

</div>

# Tutorial: from zero to a working bridge

This is the end-to-end path. The goal: let an agent inside DSH actually drive your local Unreal Editor, and know what it should do and what will hang.

Suggested reading order: this page → [protocol](02-protocol.md) → [architecture](03-architecture.md) → [command reference](command-reference.md).

---

## 1. Mental model: four facts first

Before touching anything, these four facts determine how every later operation is written. They are not design choices — they are existing UnrealAgentLink constraints.

**① The direction is reversed.** This plugin does not dial the editor; **the editor dials out**. The UnrealAgentLink C++ plugin unconditionally opens `ws://127.0.0.1:17860` in `StartupModule`, and this plugin listens on that port. So startup order does not matter: if the editor starts first it retries every 5 seconds and still connects once the plugin appears.

**② There is no authentication.** No token, no header, no subprotocol. **The port itself is the credential** — whoever can reach 17860 can drive the editor. That is why it binds loopback only by default, and why you should not change it to `0.0.0.0`.

**③ Commands run serially on the game thread.** When the editor receives a command it re-posts it to the game thread if it is not already there, then **executes it synchronously to completion**. Two consequences:

- Commands for the same editor queue naturally, and this plugin also sends per editor serially.
- **While a blocking command runs, the editor answers nothing** — not even a progress query like `sequence.render_status`. Anything else you send just queues behind it.

**④ There is no cancellation.** `query_task` / `cancel_task` do not exist in the protocol. Killing a `ual_task` job stops only **this plugin's wait**; the engine keeps running and the result still comes back. This sentence is written into `ual_task`'s tool description for the model to read.

---

## 2. Prerequisites

| Item | Requirement | Notes |
|---|---|---|
| Unreal Engine | 5.0 – 5.8 | the range declared in the plugin's `.uplugin` |
| UnrealAgentLink | the C++ plugin itself | copy into the project's `Plugins/` |
| Node.js | `^22.19.0 \|\| >=24.0.0` | see `engines` in `package.json` |
| DSH runtime | any working install | this plugin is loaded as a bundle |

**You do not need the UEBox desktop app.** It is another client from the same vendor that happens to use port 17860 too, so running both at once is a port conflict. See [README § "You do not need UEBox"](../README.md#you-do-not-need-uebox).

### Installing UnrealAgentLink into a UE project

1. Copy the whole `UnrealAgentLink` directory into the project's `Plugins/` (or the engine's `Plugins/` for a global install).
2. Regenerate project files and open the project.
3. Confirm UnrealAgentLink is enabled under **Edit → Plugins**.

The plugin automatically enables its two engine-shipped dependencies, `IKRig` and `PythonScriptPlugin` (see the `.uplugin`). Once the editor starts it begins connecting to 17860 with no configuration at all.

> If the port is taken (for example by the UEBox desktop app), give the editor a different one:
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`
> and change the `port` setting on this side to match.

---

## 3. Installing this plugin

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck + 173 tests + catalog reconciliation, one command
```

`npm run check` must be fully green before going further. It verifies three things: sources and tests both typecheck, the behaviour tests all pass, and the 170-command catalog lines up with the C++ registry entry by entry.

### Installing as a DSH bundle

`package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`, and that file does one thing:

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

**Note**: in DSH's configuration layering, a later layer **replaces** this row's `config` wholesale rather than deep-merging it. To override any key you must rewrite every key you want to keep.

#### With the installer script

DSH ships no command that installs a local out-of-tree plugin, and `dsh plugin --profile desktop` is refused outright because the Electron app manages that profile exclusively (`bin.js:38`). So this repo ships one:

```bash
npm run status:dsh -- --profile web   # what is registered right now (npm passthrough)
node scripts/install-dsh-plugin.mjs --profile web            # mirror, edit the manifest, install, verify
```

It refuses the `desktop` profile, refuses to touch a manifest a running DSH still holds, and proves the layer is composed before reporting success. If the peer-dependency guard stops the install it prints the exact command to accept the risk — **that decision is yours, not the script's**.

#### By hand

The underlying mechanism is four steps. Where `<profile>` is `web` (or any non-desktop profile):

```bash
npm run build    # the mirror ships lib/, and a mirror made before the build is a partial plugin
cp -r lib cordis.patch.yml package.json LICENSE README.md "$DSH_HOME/profiles/<profile>/.vendor/"
dsh plugin --profile <profile> install
dsh --profile <profile> --dump-config | grep -A2 '# == dsh-unreal-agentlink'
```

plus two entries in `<profile>/package.json`:

```json
"dependencies": { "dsh-unreal-agentlink": "file:C:/Users/you/.dsh/profiles/web/.vendor" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-unreal-agentlink"] } }
```

Both are mandatory and they fail differently: a listed package that declares no `dsh.bundle` fails **loud** at boot, while an installed package that is not listed contributes **no layer at all**. And `file:` must point at a copy, not at your workspace — pnpm copies what it finds at install time, so a half-saved source file becomes the plugin DSH loads.

The `desktop` profile has no CLI path: the Electron app holds a lock on its `package.json` while it runs, and a contender never deletes another holder's lock. Use the GUI's plugin manager, or close the app first.

If an AI agent is doing the installation, hand it [INSTALL-ai.md](INSTALL-ai.md) instead — it is the same procedure written as a checklist it can read and verify.

---

## 4. First connection

### Step 1: confirm the bridge is alive

Have the agent call `ual_status`. Watch four fields:

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → the plugin did not start, or the port is taken. Look for `EADDRINUSE` in the DSH log.
- `listening: true` but `editors: []` → the bridge is waiting. Confirm the UE project is open and UnrealAgentLink is enabled.

For the **first instant** after an editor connects, its record has only `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale` — fields like `project` appear only once the editor pushes `project.info`. This is a normal state, not an error.

### Step 2: discover capability

Do not guess command names. Two steps:

```
ual_tools  { filter: "material" }        → list the material family with a one-line summary each
ual_schema { method: "material.create" } → that command's param keys, required keys, result keys, status codes
```

`ual_schema`'s key names are **extracted verbatim** from the C++ handlers. Do not skip this step: **UE silently ignores unknown or wrongly-typed keys** — a misspelled key name does not error, it just "succeeds" at doing nothing.

### Step 3: the first real call

```
ual_call { method: "level.get_current" }
```

Pure read, no side effects. It returns the editor's `result` **verbatim**; this plugin does not reshape it.

### Step 4: look at the level

```
ual_screenshot { width: 1280, height: 720 }
```

What comes back is a **real image** the agent can see directly. This beats `ual_call { method: "editor.screenshot" }`, which returns only a file path.

If a screenshot's `pending_shaders` / `pending_assets` are non-zero, the view is still compiling or streaming in and **is not the final look**. Do not judge a material broken from it.

---

## 5. Common workflows

### Change an actor's property

```
ual_schema { method: "actor.set_property" }        # check key names first
ual_call   { method: "actor.get_info", params: { targets: { names: ["Cube_1"] } } }
ual_call   { method: "actor.set_property", params: {
               targets: { names: ["Cube_1"] },
               properties: { Mobility: "Movable" } } }
```

When a property name is misspelled, the editor **returns suggestions** rather than a 404. Read the suggestions; do not retry the misspelling.

### Batch operations

For a known sequence of work, use `ual_batch` to do it in one round trip:

```
ual_batch { calls: [
  { method: "actor.spawn", params: { asset_id: "cube", name: "A" } },
  { method: "actor.spawn", params: { asset_id: "cube", name: "B" } },
  { method: "actor.get_info", params: { targets: { names: ["A", "B"] } } }
] }
```

- Runs serially (the editor is serial anyway), and **stops at the first failure** by default; `continueOnError: true` changes that.
- Capped by `maxBatchCalls` (default 12).
- **If any single item is dangerous, the whole batch goes through approval.** The approval prompt names which item it was.

### Long tasks

Commands that block the game thread must go through `ual_task`:

```
ual_task { method: "sequence.render", params: { sequence_path: "/Game/Seq/Main" }, label: "Render main sequence" }
```

It returns a `jobId` immediately and the conversation continues. Collect the result with `job_output`.

Which ones are long: `sequence.render`, `cpp.compile`, `level.build`, `blueprint.compile_all`, `pcg.execute`, `pie.run`, asset imports. `ual_schema`'s timeout column marks them "blocking".

**Do not** poll the editor while a long task runs — it will not answer.

### Rollback

```
ual_undo_history            # see what is in the buffer first
ual_undo { dryRun: true }   # rehearse
ual_undo                    # actually undo
```

UnrealAgentLink maintains **one independent agent undo stack per editor**, separate from the user's Ctrl+Z history. This plugin records which DSH session each step belongs to and **rolls back only when this session's steps form a clean LIFO suffix of the buffer**. If another session has touched the editor in the meantime, the tool **undoes nothing** and reports both step lists rather than quietly discarding someone else's work.

### Claiming asset locks

Before a multi-step change to an asset:

```
ual_locks { claim: ["/Game/Materials/M_Rock"] }
... make changes ...
ual_locks { release: ["/Game/Materials/M_Rock"] }
```

The editor draws an "AI is editing" badge in the content browser, and the user is warned if they start editing it by hand. Claims from several sessions are merged into one table by this plugin before being sent, and re-sent after an editor reconnects.

### Reading logs

```
ual_logs { level: "Warning", contains: "Niagara" }
```

The log ring is empty by default — UE-side log forwarding is **off by default** and requires running `ual.ForwardLogs 1` inside the editor (this plugin cannot turn it on remotely). `ual_logs` says so when it returns nothing.

With forwarding off, use the engine's own message log instead:

```
ual_call { method: "messagelog.list", params: { limit: 50 } }
```

---

## 6. Reading failures

This plugin **never parses error text** (the text switches between Chinese and English with editor culture). It classifies by **error class name and status code** only, into 16 kinds.

| kind | Meaning | What to do |
|---|---|---|
| `no-editor` | no editor is connected | open the UE project; confirm the plugin is enabled |
| `timeout` | timed out, **the command may still be running** | **do not resend**. Confirm actual state with a read command first |
| `editor-lost` | the editor disconnected | wait for its 5-second reconnect |
| `queue-stalled` | an earlier command timed out | check `orphaned` in `ual_status` |
| `circuit-open` | repeated transport failures opened the breaker | stop, wait for the cooldown, check `ual_status` |
| `rate-limited` | the rate-limit queue is full | slow down |
| `not-found` | no such method or asset | use `ual_tools` to find the real command name |
| `bad-params` | a parameter is missing or mistyped | check key names with `ual_schema` |
| `precondition` | a precondition failed (412/413/422) | read `details`; 422 means "input valid but nothing was written" |
| `registry-busy` | the asset registry is still scanning | poll `content.registry_status` |
| `unsupported` | this editor version does not support it | e.g. `anim.*` needs UE 5.5+ |
| `engine-error` | the editor itself failed | read `result.message` (for humans) and `details` (for machines) |

**Timeout is the kind that most needs discipline.** The protocol has no cancellation, so a timeout means only "this plugin stopped waiting" — the command is very likely still running on the game thread. The correct response is: check `orphaned` in `ual_status`, then verify actual state with a read-only command, and **do not resend**.

---

## 7. Configuration

Every key is changeable, and the defaults are "alive but lazy". The full table is in [README § Configuration](../README.md#configuration). A few worth noting:

- **`port`** — change it here and the UE side needs `-UALServer=` too.
- **`rateLimitRps: 0`** — disables rate limiting.
- **`rollbackOnDispose: false`** — does **not** auto-undo when a session ends. Turning it on means rollback on dispose, which is usually a surprise the user did not ask for.
- **`logForwardingEnabled: false`** — set to `true` only after running `ual.ForwardLogs 1` inside the editor.

---

## 8. Troubleshooting

**`ual_status` shows `listening: true` but no editor**
The UE project is not open, or UnrealAgentLink is not enabled. You can also check `LogUALNetwork` in the editor log: normally you should see `Connecting to ws://127.0.0.1:17860` and `Connected to`.

**`EADDRINUSE` at startup**
17860 is taken. Most often by the UEBox desktop app. Close it, or move both the editor and this plugin to another port.

**Commands all return `unknown-method` or are refused outright**
This plugin only lets through the 170 commands that genuinely exist in its catalog. Use `ual_tools` to confirm the name. Deprecated commands (such as `editor.play`, `take_screenshot`) return the replacement to use.

**Screenshots are black or half-finished**
Check `pending_shaders` / `pending_assets`. Non-zero means compilation or streaming has not finished. Raise `warmup_frames` and retry.

**`ual_undo` refuses to run**
This session's steps are not a clean LIFO suffix of the buffer — another session touched the editor in the meantime. This is **deliberate protection**, not a bug. Use `ual_undo_history` to see the real contents.

**A configuration change had no effect**
DSH's configuration layering **replaces** that row's `config` wholesale rather than deep-merging. You must write out every key you want to keep.

**`ual_task` killed the job but the editor is still busy**
Expected. The protocol has no cancellation. Wait for it to finish — or, more practically, do not send other commands while a long task runs.

---

## 9. Next steps

- [Protocol reference](02-protocol.md) — message shapes, events, status codes
- [Architecture](03-architecture.md) — the reasoning behind the gate chain, session isolation, and error translation
- [Command reference](command-reference.md) — full params and result keys for all 170 commands (generated)
