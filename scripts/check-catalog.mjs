/**
 * Check `catalog/methods.ts` against the extracted plugin data.
 *
 * Three failures matter and only three:
 *
 * 1. a cataloged method the plugin does not register → the bridge advertises a
 *    capability that 404s;
 * 2. a registered method missing from the catalog → the bridge refuses a working
 *    command;
 * 3. a `requires` key that does not exist anywhere in the C++ → `ual_call`
 *    rejects a *valid* request before it is ever sent, which is worse than a 400
 *    because the model cannot see what the engine would have said.
 *
 * Check 3 must be asked of the C++ source, not of the generated tables. An
 * earlier version compared `REQUIRED_KEYS` against `PARAM_KEYS` — both emitted by
 * `extract-methods.mjs` from the same parse — so it could only ever agree with
 * itself, and it reported OK while nothing in `src/` imported either table.
 *
 * The vitest suite runs the same checks; this is the fast path for iterating on
 * the catalog from a terminal.
 *
 *   node scripts/check-catalog.mjs [path/to/UnrealAgentLink/Source]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataText = readFileSync(join(repo, 'src', 'catalog', 'method-data.ts'), 'utf8')
const catalogText = readFileSync(join(repo, 'src', 'catalog', 'methods.ts'), 'utf8')
const typesText = readFileSync(join(repo, 'src', 'protocol', 'types.ts'), 'utf8')

const arrayIn = (text, name) => {
  // The generated file declares these with a type annotation and no `as const`,
  // while hand-written ones (UAL_CODES) end in `as const` — match both, plus an
  // optional trailing comma before the closing bracket.
  const found = new RegExp(`${name}(?::[^=]*)? = (\\[[\\s\\S]*?\\])\\s*(?:as const)?\\s*;?\\s*\\n`).exec(text)
  return found ? JSON.parse(found[1].replace(/,\s*\]$/, ']')) : []
}
const array = name => arrayIn(dataText, name)
const table = varName => {
  const block = new RegExp(`${varName}(?::[^=]*)? = \\{([\\s\\S]*?)\\n\\}`).exec(dataText)
  const out = {}
  if (!block) return out
  for (const entry of block[1].matchAll(/"([^"]+)": \[([^\]]*)\]/g)) {
    out[entry[1]] = entry[2].split(',').map(item => item.trim().replace(/^"|"$/g, '')).filter(Boolean)
  }
  return out
}

const registered = new Set(array('UAL_REGISTERED_METHODS'))
const unresolved = new Set(array('PARAMS_UNRESOLVED'))
const params = table('PARAM_KEYS')
const derived = table('REQUIRED_KEYS')
const methodCodes = table('METHOD_CODES')

// `UAL_CODES` (src/protocol/types.ts) is the hand-declared set `translate()` is
// read against, so it is checked rather than trusted: every code the per-method
// table records must appear in it, and it must not name a code no handler sends.
const declaredCodes = new Set(arrayIn(typesText, 'UAL_CODES'))

// The catalog's own method keys. Entries are written as
// `  'a.b': read('…', { requires: ['x'] })`, so walk it line by line and keep
// each requires array attached to the method it appeared under. Hand-written
// `requires` arrays are no longer used (the derived table below replaced them),
// but a stray one must still be validated rather than silently trusted.
const catalog = new Map()
let current = null
for (const line of catalogText.split('\n')) {
  const key = /^\s{2}(?:'([^']+)'|"([^"]+)"|([a-z_]+\.[a-z_0-9]+))\s*:\s*(?:read|write|destroy|danger)\(/.exec(line)
  if (key) {
    current = key[1] ?? key[2] ?? key[3]
    catalog.set(current, [])
    continue
  }
  if (!current) continue
  const requires = /requires:\s*\[([^\]]*)\]/.exec(line)
  if (requires) {
    catalog.set(
      current,
      requires[1].split(',').map(item => item.trim().replace(/^'|'$/g, '')).filter(Boolean),
    )
  }
  if (/^\s*\}/.test(line)) current = null
}

const notRegistered = [...catalog.keys()].filter(method => !registered.has(method))
const notCataloged = [...registered].filter(method => !catalog.has(method))

// ── the C++ ground truth ────────────────────────────────────────────────────
// Every string literal the handlers mention. A required key must appear as a
// literal somewhere in the plugin's own source: the harvest reads
// `TEXT("Missing field: X")`, so `X` is always spelled out in the C++.
const sourceRoot = process.argv[2] ?? join(repo, '.ua-ref', 'plugin', 'UnrealAgentLink', 'Source')
const cppLiterals = new Set()
// Codes sent anywhere in the C++, including shared gates that no single handler
// body contains — `FUAL_RegistryReady::Ensure` sends 503 from
// `Private/Utils/UAL_RegistryReady.cpp` on behalf of every registry reader, so a
// per-method harvest cannot see it.
//
// Codes also arrive as expressions, not just literal arguments:
// `SendResponse(RequestId, FailedJson.Num() > 0 ? 207 : 200, Data)` and
// `const int32 Code = bOk ? 200 : (NumOk > 0 ? 207 : 400)`. So scan whole
// statements rather than one argument slot — a bare `\d{3}` sweep over the file
// would pick up buffer sizes and make the check cry wolf.
const cppCodes = new Set()
const collectCodes = statement => {
  for (const match of statement.matchAll(/\b(\d{3})\b/g)) cppCodes.add(Number(match[1]))
}
const collect = dir => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      collect(path)
      continue
    }
    if (!/\.(cpp|h)$/.test(entry)) continue
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/TEXT\(\s*"([^"]*)"\s*\)/g)) {
      for (const word of match[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) cppLiterals.add(word)
    }
    // The statement containing each Send* call, plus any `Code = …` assignment
    // whose value is later handed to one.
    for (const match of text.matchAll(/[^;{}]*Send(?:Error|Response)\([^;]*;/g)) collectCodes(match[0])
    for (const match of text.matchAll(/\b(?:int32|int|uint8)\s+Code\s*=[^;]*;/g)) collectCodes(match[0])
  }
}
let haveSource = true
try {
  collect(sourceRoot)
} catch {
  haveSource = false
}

// The keys that actually gate `service.call()`: the derived table, plus any stray
// hand-written `requires` still in the catalog.
const claimed = new Map([...Object.entries(derived), ...[...catalog.entries()].filter(([, list]) => list.length > 0)])
const badRequires = haveSource
  ? [...claimed.entries()]
      .filter(([method]) => registered.has(method) && !unresolved.has(method))
      .flatMap(([method, requires]) => requires.filter(key => !cppLiterals.has(key)).map(key => `${method} → "${key}"`))
  : []

console.log(`catalog: ${catalog.size}   registered: ${registered.size}`)
if (!haveSource) {
  console.log(`SKIP check 3: no C++ source at ${sourceRoot} (pass a path to enable it)`)
}
const report = (label, items) => {
  if (items.length === 0) console.log(`OK   ${label}`)
  else console.log(`FAIL ${label} (${items.length})\n  ${items.join('\n  ')}`)
}
report('every cataloged method is registered', notRegistered)
report('every registered method is cataloged', notCataloged)
if (haveSource) {
  report(`every required key is named in the C++ (${cppLiterals.size} literals)`, badRequires)
}

// Check 4: the declared code set must match what the C++ really sends. A code
// recorded against a method but missing from UAL_CODES means `translate()` has a
// hole (it silently falls through to `engine-error`); a code in UAL_CODES that
// nothing sends is dead weight claiming coverage that does not exist.
//
// The authority is the C++ source, not the per-method table: shared gates send
// codes no handler body contains (503 from `FUAL_RegistryReady::Ensure`), so
// asking the table alone would call a real code undeclared. Without the vendored
// source, fall back to the table and say so.
const sentCodes = haveSource ? cppCodes : new Set(Object.values(methodCodes).flat().map(Number))
const missingFromDeclared = [...sentCodes]
  .filter(code => !declaredCodes.has(code))
  .map(code => `sent in the C++ but not in UAL_CODES: ${code}`)
const declaredButNeverSent = [...declaredCodes]
  .filter(code => !sentCodes.has(code))
  .map(code => `in UAL_CODES but never sent: ${code}`)
const codeProblems = [...missingFromDeclared, ...declaredButNeverSent]
const codeSource = haveSource ? `${sentCodes.size} sent in the C++` : `${sentCodes.size} in the table (no C++ source)`
report(`UAL_CODES agrees with the plugin's own code set (${declaredCodes.size} declared, ${codeSource})`, codeProblems)

const failed =
  notRegistered.length + notCataloged.length + badRequires.length + codeProblems.length > 0
process.exit(failed ? 1 : 0)
