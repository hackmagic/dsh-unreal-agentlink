<div align="center">

**English** · [简体中文](zh/INSTALL-ai.md) · [繁體中文](zh-TW/INSTALL-ai.md) · [日本語](ja/INSTALL-ai.md) · [한국어](ko/INSTALL-ai.md) · [Deutsch](de/INSTALL-ai.md) · [Español](es/INSTALL-ai.md) · [Français](fr/INSTALL-ai.md) · [Русский](ru/INSTALL-ai.md)

[README](../README.md) · [Tutorial](01-tutorial.md) · [Protocol](02-protocol.md) · [Architecture](03-architecture.md) · [Command reference](command-reference.md) · **Install guide**

</div>

# Install (AI-readable)

This file is written for an AI assistant that reads files and executes steps in order.
Do not skip steps; every step has a verifiable outcome. For a human install, see the
[README](../README.md) or the [tutorial](01-tutorial.md).

> The AI only needs to run `scripts/install-dsh-plugin.mjs`. That script does
> everything: mirror → edit the profile manifest → call the real installer →
> verify the composed result. Each step below is a **verification point**: if a
> step does not match, stop and report it. Do not continue.

---

## 0. Check first (read-only, installs nothing)

```bash
node scripts/install-dsh-plugin.mjs --profile web --status
```

`installed copy:` and `bundle layer:` should read `present` / `listed`. Only if
they read `(absent)` / `(not listed)` does an install need to run.

Then check the UnrealAgentLink side:

- `Plugins/UnrealAgentLink/` exists in the project and is enabled under
  `Edit → Plugins` (the editor needs a restart).
- Port 17860 is free (`uebox` desktop claims the same port; this plugin does not
  need it).

---

## 1. Install (one command)

```bash
npm run build && node scripts/install-dsh-plugin.mjs --profile web --yes
```

The script performs five actions, each leaving evidence:

| Step | Artifact | Meaning on failure |
| --- | --- | --- |
| build | `lib/`, 64 files | run `npm run check` first; do not install a broken build |
| mirror | `<profile>/.vendor/` containing only `files` entries | disk or permission problem |
| manifest edit | `<profile>/package.json` gains one dependency line + one bundle line | see §4 |
| installer | pnpm prints `Done in Xs` | see §2 |
| verify | `install: ... is now a bundle layer of profile "web"` | see §3 |

**Only the last line means the install succeeded.** If the first four steps pass
and the fifth fails, the layer is not composed and dsh will not load the plugin.

---

## 2. If the installer refuses (version guard)

dsh has a product-level guard: an install is refused when the plugin's
`peerDependencies` are incompatible with the runtime's dsh version. This project
pins `@deepseek-ai/*` at `0.1.6-alpha.2` while the shipped dsh is `0.2.0-rc.2`,
so the install stops here.

**That is a product decision; the script deliberately does not make it for you.**
It prints the exact command:

```bash
dsh plugin --profile web allow-version dsh-unreal-agentlink@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

Running it requires human confirmation. Then re-run the install from §1.

> `--status` shows whether the exemption is already active on the
> `version guard:` line.

---

## 3. If the verification step fails (layer not composed)

```bash
dsh --profile web --dump-config | grep unreal-agentlink
```

This must print:

```
# == dsh-unreal-agentlink
- id: unreal-agentlink
  name: dsh-unreal-agentlink
```

Three known causes when it does not:

1. `dsh.profile.bundles` does not list this plugin — the script should have added
   it; check `<profile>/package.json`.
2. The package is in `node_modules` but declares no `dsh.bundle` — this fails
   **loud** at load (`declares no dsh.bundle in its package.json`); check the
   mirrored `package.json`.
3. `--dump-config` itself errors — report the full output verbatim, do not guess.

---

## 4. If the manifest edit is lock-refused

```
install: <path>/package.json.lock is held by pid 18344 (DeepSeek Harness)
```

dsh protects a profile manifest with a `wx`-created `.lock` sibling, and **a
contender never deletes another holder's lock**. The holder is the running dsh
application itself.

- For the `web` profile: close the running DeepSeek Harness desktop app, or pick
  a profile that is not held.
- For the `desktop` profile: the CLI is **forbidden** (`bin.js:38`
  `rejectElectronProfile`); only the Electron app may manage it, or close the app
  and edit by hand.
- The script refuses and names the holder; it does not fight the lock.

---

## 5. Verify the plugin actually works (being installed is not enough)

```bash
# a) Editor side: open the project. The UE log should show a connection.
#    (UnrealAgentLink retries every 5 seconds; no manual connect is needed.)

# b) DSH side: ask the agent in a session to "check the editor with ual_status".
```

The three `ual_status` fields are the acceptance criteria:

| Field | Expected |
| --- | --- |
| `listening` | `true` |
| `editors` | at least one, carrying a `project` name |
| `orphanedMethods` | `[]` |

`listening: false` = nothing is listening (plugin not loaded, or port taken).
`editors: []` = UE did not connect (project closed, plugin disabled, or a port mismatch).
A non-empty `orphanedMethods` = a request timed out but may still be running;
check `ual_logs` before retrying.

Then confirm the whole path with one minimal call:

```bash
# in a session: ual_call { "method": "level.get_current" }
```

---

## 6. Uninstall

```bash
node scripts/install-dsh-plugin.mjs --profile web --remove --yes
```

The script drops both the dependency and the bundle entry, then runs the real
installer so pnpm syncs `node_modules`. The mirror directory
`<profile>/.vendor` is kept and rebuilt on the next install; delete it by hand
if you want it gone.

---

## Hard rules for the AI

1. **Do not** edit this project's `peerDependencies` to make an install pass —
   that would hide a real version incompatibility.
2. **Do not** hand-edit `<profile>/package.json`; the script does it and it
   checks the lock.
3. **Do not** treat `--accept-risk` as automatically executable; it needs human
   confirmation.
4. If any step's output differs from what is described, **stop and report the
   output verbatim**; do not "try a fix and re-run".
5. Every step here can be re-verified with read-only commands (`--status`,
   `--dump-config`, `ual_status`).
