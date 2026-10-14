/**
 * Regenerate `src/catalog/method-data.ts` from the UnrealAgentLink plugin source.
 *
 * Why a generator instead of a hand-written table: this bridge forwards 170 methods
 * whose parameter names are documented only in Chinese markdown and in C++ that
 * reads `TryGetStringField(TEXT("asset_path"))`. A hand-typed table drifts silently,
 * and a drifted key is worse than a missing one — UE's `TryGet*Field` accessors
 * fail closed, so a wrong key is a *successful-looking no-op*.
 *
 * Usage:
 *   node scripts/extract-methods.mjs [pathToUnrealAgentLinkSource]
 *
 * The source root is `<uebox checkout>/plugin/UnrealAgentLink/Source`; it defaults
 * to the `.ua-ref` copy this repo keeps.
 *
 * Per registered method it extracts: the param keys the handler reads, the keys the
 * plugin itself declares mandatory (from its own `Missing field:` errors), the
 * result keys it writes, and the codes it can answer with.
 *
 * @module scripts/extract-methods
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const sources = process.argv[2] ?? join(repo, '.ua-ref', 'plugin', 'UnrealAgentLink', 'Source')

if (!existsSync(sources)) {
  console.error(`no plugin source at ${sources}`)
  console.error('fetch one, e.g.:  git clone --depth 1 https://github.com/ueboxai/uebox')
  console.error('then point this script at <checkout>/plugin/UnrealAgentLink/Source')
  process.exit(1)
}

const cppFiles = []
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (full.endsWith('.cpp')) cppFiles.push(full)
  }
}
walk(sources)

/** Every `TEXT("…")` a pattern captures, deduplicated and sorted. */
const captures = (body, pattern) => [...new Set([...body.matchAll(new RegExp(pattern, 'g'))].map(match => match[1]))].sort()

/** Method names are dot-namespaced lowercase; anything else is not a registration. */
const DOT_METHOD = /^[a-z_]+\.[a-z_][a-z0-9_]*$/

/**
 * Parse `<map>.Add(TEXT("method"), <handler>)` into method + second argument.
 *
 * Paren-balanced, not a fixed window. The window version was wrong in a way that
 * produced plausible-but-false data: `Commands.Add(TEXT("anim.measure"),
 * UALAnimation::Measure)` has no brace of its own, so a window scan picked up some
 * unrelated function's body and attributed its keys to this method. A table entry
 * that looks extracted is worse than one marked missing, because `ual_schema`
 * states it to the model as fact.
 *
 * The map parameter is not always `CommandMap` either: three files call theirs
 * `Commands`, and matching only `CommandMap` silently dropped six real methods —
 * which is how a research pass concluded `actor.inspect_components` did not exist.
 */
function parseRegistrations(text, file) {
  const found = []
  for (const match of text.matchAll(/([A-Za-z_]\w*)\s*\.\s*(?:Add|Emplace|Set|TryAdd)\s*\(\s*TEXT\(\s*"([^"]+)"\s*\)/g)) {
    const method = match[2]
    if (!DOT_METHOD.test(method)) continue
    let index = match.index + match[0].length
    let depth = 1
    let inString = false
    let escape = false
    while (index < text.length && depth > 0) {
      const char = text[index]
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (inString) {
        if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '(' || char === '{' || char === '[') depth += 1
      else if (char === ')' || char === '}' || char === ']') depth -= 1
      index += 1
    }
    const args = text.slice(match.index + match[0].length, Math.max(match.index + match[0].length, index - 1))
    const comma = findTopLevelComma(args)
    if (comma < 0) continue
    const handlerArg = args.slice(comma + 1).trim()
    const isLambda = handlerArg.startsWith('[')
    found.push({
      method,
      handler: isLambda ? '' : (/([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)/.exec(handlerArg)?.[1] ?? ''),
      lambdaBody: isLambda ? braceBody(handlerArg) : '',
      file,
    })
  }
  return found
}

/** Index of the first comma at nesting depth zero. */
function findTopLevelComma(input) {
  let depth = 0
  let inString = false
  let escape = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (escape) escape = false
    else if (char === '\\') escape = true
    else if (inString) {
      if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) return index
  }
  return -1
}

/** The balanced `{…}` inside an argument, or the argument itself. */
function braceBody(input) {
  const start = input.indexOf('{')
  if (start < 0) return input
  let depth = 0
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === '{') depth += 1
    else if (input[index] === '}') {
      depth -= 1
      if (depth === 0) return input.slice(start, index + 1)
    }
  }
  return input.slice(start)
}

const registrations = []
for (const file of cppFiles) {
  for (const entry of parseRegistrations(readFileSync(file, 'utf8'), file)) {
    if (!registrations.some(existing => existing.method === entry.method)) registrations.push(entry)
  }
}

// Alias loops register under a variable key, which the parser cannot see:
//   for (const FString& Method : {TEXT("anim.measure"), …}) Commands.Add(Method, …)
// That specific one is the `#if UE >= 5.5` fallback — on an older engine all four
// `anim.*` methods answer 501 from ONE shared lambda, which is why they must be
// cataloged (a 404 would hide the real reason) and why their shared body matters.
for (const file of cppFiles) {
  const text = readFileSync(file, 'utf8')
  for (const loop of text.matchAll(/for\s*\([^)]*:\s*\{([^}]*)\}\s*\)\s*\n?\s*([\s\S]{0,700}?);\n/g)) {
    const names = [...loop[1].matchAll(/TEXT\(\s*"([a-z_]+\.[a-z0-9_]+)"\s*\)/g)].map(match => match[1])
    if (names.length === 0) continue
    const body = loop[2]
    const lambda = /\[[^\]]*\][\s\S]*/.exec(body)?.[0] ?? ''
    const handler = /,\s*([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)?)\s*[,)]/.exec(body)?.[1] ?? ''
    for (const method of names) {
      if (registrations.some(entry => entry.method === method)) continue
      registrations.push({ method, handler, lambdaBody: lambda ? braceBody(lambda) : '', file })
    }
  }
}

const referenced = new Set(
  registrations
    .map(entry => entry.handler)
    .filter(Boolean)
    .map(name => name.split('::').pop()),
)

/**
 * Index definitions, keyed by bare name.
 *
 * A prefix filter (`Handle_`) would be the easy thing and it is wrong: the
 * component-inspect, sequence-diff and animation files register bare functions
 * (`Measure`, `Preview`, `Retarget`) that no prefix rule matches, and a delegating
 * lambda (`{ Handle_SpawnActor(Payload, Id); }`) needs its *target* indexed.
 *
 * A prototype is excluded by ending in `;`; a definition's parameter list does
 * not, even when the opening brace is on the next line or the list is split.
 * Several candidates per name are kept and resolved by REGISTERING FILE, because a
 * name as generic as `Preview` exists in other command files too, and taking the
 * wrong one attributes another function's keys to this method.
 */
const definitions = new Map()
for (const file of cppFiles) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line || /^[/*#]/.test(line)) return
    if (line.endsWith(';')) return
    const name = definedName(raw)
    if (!name) return
    if (!referenced.has(name) && !/^(?:Handle_|UAL_[A-Za-z0-9_]+$)/.test(name)) return
    const existing = definitions.get(name) ?? []
    definitions.set(name, existing.filter(entry => entry.file !== file).concat([{ file, line: index }]))
  })
}

/** The identifier immediately before the `(` of a signature line. */
function definedName(line) {
  const open = line.indexOf('(')
  if (open <= 0) return ''
  const before = line.slice(0, open)
  if (/[=;]/.test(before)) return ''
  return /([A-Za-z_]\w*)\s*$/.exec(before)?.[1] ?? ''
}

function resolveDefinition(name, fromFile) {
  const candidates = definitions.get(name)
  if (!candidates || candidates.length === 0) return undefined
  return candidates.find(entry => entry.file === fromFile) ?? candidates[candidates.length - 1]
}

const fileLines = new Map()
const linesOf = file => {
  let cached = fileLines.get(file)
  if (!cached) {
    cached = readFileSync(file, 'utf8').split('\n')
    fileLines.set(file, cached)
  }
  return cached
}

/** A balanced-brace body starting at a definition line. */
function bodyOf(file, startLine) {
  const lines = linesOf(file)
  let depth = 0
  let started = false
  const out = []
  for (let index = startLine; index < Math.min(lines.length, startLine + 1500); index += 1) {
    const line = lines[index]
    out.push(line)
    for (const char of line) {
      if (char === '{') {
        depth += 1
        started = true
      } else if (char === '}') depth -= 1
    }
    if (started && depth <= 0) break
  }
  return out.join('\n')
}

/**
 * Inbound parameter reads.
 *
 * Only unambiguous ones. The bare `Get*Field` family is deliberately absent: it is
 * used as often on a nested object the handler built itself as on inbound params,
 * and including it would invent parameters. `Strings(Payload, TEXT("k"))` and
 * `LoadAnimation(Input, TEXT("path"))` are local helpers, named exactly so they
 * cannot match a `Set*Field` write.
 */
const READ_PATTERNS = [
  'TryGet(?:String|Number|Integer|Bool|Object|Array)\\w*Field\\(\\s*TEXT\\(\\s*"([^"]+)"',
  'HasField\\(\\s*TEXT\\(\\s*"([^"]+)"',
  'Read(?:StringArray|String|Number|Bool|Object|Vector|Rotator)\\(\\s*TEXT\\(\\s*"([^"]+)"',
  'Strings\\(\\s*(?:Payload|Input|Params)\\s*,\\s*TEXT\\(\\s*"([^"]+)"\\s*\\)',
  'Load(?:Animation|Sequence|Asset)\\(\\s*\\w+\\s*,\\s*TEXT\\(\\s*"([^"]+)"\\s*\\)\\s*\\)',
]

const WRITE_PATTERN = 'Set(?:String|Number|Bool|Object|Array)Field\\(\\s*TEXT\\(\\s*"([^"]+)"'

/**
 * The keys the plugin declares mandatory, from its own refusals:
 * `SendError(…, 400, TEXT("Missing field: blueprint_path"))`,
 * `TEXT("Missing field: sequence_path / camera_label")`.
 *
 * Derived rather than authored, and that is the point: a wrong "required" claim
 * makes the bridge reject a VALID call before the engine sees it, so the caller
 * gets a confident false statement instead of the handler's real error. The first
 * draft of this catalog had 101 hand-guessed required entries and 50 named a key
 * nothing reads. Coverage here is partial by nature, which is the safe direction:
 * fewer gates, never a wrong one.
 *
 * A message offering a CHOICE ("Missing field: name or path") claims nothing on
 * its own — `actor.get` is perfectly happy with `path` alone — so any message
 * containing "or" is skipped entirely rather than mined for its first key.
 *
 * Harvested from the HANDLER'S OWN body only, never from the same-file callees
 * that `PARAM_KEYS`/`RESULT_KEYS` follow: a callee is reached on some branches and
 * not others, so a refusal inside one does not make the key mandatory. Following
 * `UAL_CreateNodeInternal` from `blueprint.create_graph` is the worked example —
 * its `struct_type`/`target_class` checks fire only for `makestruct`/`breakstruct`
 * and `cast`/`castto` nodes, so a `nodes` array of `branch`/`call` specs needs
 * neither key.
 */
const REQUIRED_PATTERNS = ['Missing field:\\s*([^"\\n]*)']

/**
 * Keys a handler's harvest names, but only on a branch.
 *
 * The harvest cannot see control flow, so a refusal reached through a callee or
 * behind an early dispatch still reads as unconditional. Each entry here is a key
 * verified by hand to be branch-local; the cost of keeping it is a bridge-side
 * rejection of a call the engine would have accepted, which is the failure mode
 * this whole table is written to avoid.
 *
 * `input.add_mapping` — `key` is unconditional, but `context_path`/`action_path`
 * are only reached after the `system == "legacy"` dispatch, which goes to
 * `AddLegacyMapping` and needs `name` instead (UAL_InputCommands.cpp:1518-1522 →
 * :1398, :1401; the pair is read at :1537-1540).
 *
 * `blueprint.create_graph` — the only unconditional keys are `blueprint_path` and
 * `nodes` (UAL_BlueprintCommands.cpp:7567, :7582), neither of which the regex can
 * see (the wording differs, and `nodes` is an array). `struct_type`/`target_class`
 * come from the per-node spec parsed at UAL_BlueprintCommands.cpp:7285-7286 and
 * consumed by the same-file callee `UAL_CreateNodeInternal` (:3117, called :7836),
 * where they are read only for `makestruct`/`breakstruct` (:4165-4169) and
 * `cast`/`castto` (:3933-3937) nodes — a `nodes` array of `branch`/`call` specs
 * needs neither.
 */
const REQUIRED_DROPPED = {
  'input.add_mapping': ['action_path', 'context_path'],
  'blueprint.create_graph': ['struct_type', 'target_class'],
}

const requiredKeysOf = body => {
  const keys = new Set()
  for (const pattern of REQUIRED_PATTERNS) {
    for (const match of body.matchAll(new RegExp(pattern, 'g'))) {
      const message = match[1]
      if (/\bor\b/.test(message)) continue
      for (const part of message.split('/')) {
        // Take the leading identifier only: the message may carry prose after the
        // key name (`Missing field: struct_type for %s`, `… for Cast node`).
        const key = part.trim().match(/^[a-z_0-9]+/)?.[0]
        if (key) keys.add(key)
      }
    }
  }
  return [...keys].sort()
}

const table = registrations
  .map(({ method, handler, file, lambdaBody }) => {
    const bare = handler ? handler.split('::').pop() : ''
    const where = bare ? resolveDefinition(bare, file) : undefined
    let body = where ? bodyOf(where.file, where.line) : lambdaBody

    // Follow function references one hop, inside the SAME file only. This is what
    // recovers the dominant shape: a lambda that merely delegates, whose own body
    // reads nothing. Cross-file builders are never followed — `BuildActorInfo`
    // lives in UAL_CommandUtils and is shared by half the actor commands, so
    // pulling it in would attribute its keys to methods that do not return them.
    // Those cases are hand-verified in `catalog/method-overrides.ts`.
    //
    // The callee bodies are what make the REQUIRED harvest work at all, since a
    // registration lambda usually reads nothing itself. They are also why the
    // harvest can over-reach: a refusal inside a callee that runs on some branches
    // only still reads as unconditional. Those keys are named in REQUIRED_DROPPED.
    const currentFile = where?.file ?? file
    const seen = new Set(where ? [where] : [])
    const queue = [body]
    for (let pass = 0; pass < 3 && queue.length > 0; pass += 1) {
      const chunk = queue.shift()
      for (const match of chunk.matchAll(/([A-Za-z_][\w]*(?:::[A-Za-z_]\w*)?)\s*\(/g)) {
        const helper = resolveDefinition(match[1].split('::').pop(), currentFile)
        if (!helper || helper.file !== currentFile || seen.has(helper)) continue
        seen.add(helper)
        const extra = bodyOf(helper.file, helper.line)
        body += `\n${extra}`
        queue.push(extra)
      }
    }

    const params = [...new Set(READ_PATTERNS.flatMap(pattern => captures(body, pattern)))].sort()
    return {
      method,
      params,
      required: requiredKeysOf(body)
        .filter(key => params.includes(key))
        .filter(key => !REQUIRED_DROPPED[method]?.includes(key)),
      result: captures(body, WRITE_PATTERN),
      codes: [...new Set([...body.matchAll(/Send(?:Error|Response)\([^,]+,\s*(\d{3})/g)].map(match => Number(match[1])))].sort((a, b) => a - b),
    }
  })
  .sort((a, b) => (a.method < b.method ? -1 : 1))

if (table.length === 0) {
  console.error('extracted zero methods — the source layout changed; refusing to write an empty table')
  process.exit(1)
}

/**
 * Methods whose shape could not be established.
 *
 * Deliberately narrow: a handler that reads no param but WRITES result keys was
 * clearly found and is genuinely parameter-less (`level.get_current`, `cpp.probe`,
 * `editor.get_dirty` all take nothing). Only a body yielding neither side is a
 * real gap. Cross-file builders are excluded because they are covered by
 * `method-overrides.ts`.
 */
const HANDLED_ELSEWHERE = [
  'content.registry_status',
  'system.get_editor_health',
  'system.get_performance_stats',
  'system.get_project_info',
  'project.info',
  'editor.get_project_info',
  'editor.screenshot',
  'editor.capture_app_window',
]
const unresolved = table
  .filter(entry => entry.params.length === 0 && entry.result.length === 0 && !HANDLED_ELSEWHERE.includes(entry.method))
  .map(entry => entry.method)

const quote = value => JSON.stringify(value)
const list = items => `[${items.join(', ')}]`
const rows = get => table.map(entry => `  ${quote(entry.method)}: ${list(get(entry).map(quote))},`).join('\n')
const codeRows = table.map(entry => `  ${quote(entry.method)}: ${list(entry.codes)},`).join('\n')

const content = `/**
 * Machine-extracted UnrealAgentLink method data: the parameter keys each handler
 * reads, the keys the plugin declares mandatory, the result keys it writes, and
 * the codes it answers with — verbatim from the plugin C++ (\`ueboxai/uebox\` →
 * \`plugin/UnrealAgentLink/Source\`).
 *
 * GENERATED — do not hand-edit. Regenerate with:
 *
 *     node scripts/extract-methods.mjs [path/to/plugin/UnrealAgentLink/Source]
 *
 * ## Why generated
 *
 * A wrong key is worse than a missing one. UE reads params with \`TryGetStringField\`
 * / \`TryGetBoolField\` / \`TryGetNumberField\`, which fail closed: an unrecognized key
 * is silently ignored and a wrongly-typed value becomes the handler's default. So a
 * typo in a hand-maintained table shows up as a command that returns \`ok: true\` and
 * changes nothing — the one failure mode an agent cannot notice.
 *
 * The tables also preserve upstream's own inconsistencies (\`path\` on
 * \`content.describe\`, \`material_path\` on \`material.add_node\`, \`blueprint_path\` on
 * the blueprint family, \`parent_class\` with a \`parentClass\` fallback on
 * \`blueprint.create\`). Normalising them here would invent a protocol the plugin
 * does not speak.
 *
 * @module catalog/method-data
 */

/** method -> parameter keys its handler reads. */
export const PARAM_KEYS: Readonly<Record<string, readonly string[]>> = {
${rows(entry => entry.params)}
}

/**
 * method -> the keys the plugin refuses without, taken from its OWN 400 messages
 * (\`Missing field: X\`). An empty list means nothing is provable, NOT "takes
 * nothing"; it is never a hand-written guess, because a wrong required key makes
 * the bridge reject a valid call before the engine can answer it.
 */
export const REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = {
${rows(entry => entry.required)}
}

/** method -> result keys the handler writes (flattened across nested objects). */
export const RESULT_KEYS: Readonly<Record<string, readonly string[]>> = {
${rows(entry => entry.result)}
}

/**
 * method -> the codes it can answer with.
 *
 * \`200\` is success; \`207\` is PARTIAL success, with the failures listed in the
 * body's \`failed\` / \`errors\`. \`0\` is never used. An empty list means no \`Send*\` call
 * was visible in the body — a gap, not a claim that the method cannot fail.
 */
export const METHOD_CODES: Readonly<Record<string, readonly number[]>> = {
${codeRows}
}

/**
 * Every method the plugin registers (${table.length}). Anything absent here is a
 * 404 on the wire and must not be advertised by this bridge.
 */
export const UAL_REGISTERED_METHODS: readonly string[] = ${list(table.map(entry => quote(entry.method)))}

/**
 * The ${unresolved.length} methods whose handler body could not be bound, so their
 * \`PARAM_KEYS\` entry is EMPTY **but they do take parameters**. Named rather than
 * silently empty, because an empty list reads as "takes nothing" and \`ual_schema\`
 * would tell the model that. \`catalog/method-overrides.ts\` carries their keys, read
 * off the source by hand, and \`ual_schema\` marks them as un-extracted.
 */
export const PARAMS_UNRESOLVED: readonly string[] = ${list(unresolved.map(quote))}
`

writeFileSync(join(repo, 'src', 'catalog', 'method-data.ts'), content, 'utf8')
console.log(`wrote src/catalog/method-data.ts: ${table.length} methods, ${unresolved.length} unresolved`)
if (unresolved.length > 0) console.log(`  ${unresolved.join(', ')}`)
