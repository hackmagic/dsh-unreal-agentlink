/**
 * Make every `requires` in `catalog/methods.ts` a key its handler actually reads.
 *
 * The catalog is written by hand (risk, summary, warnings) but `requires` is a
 * *fact* about the plugin, and a wrong required key is worse than no required key:
 * `service.call()` rejects the request before sending, so the model cannot even see
 * what the engine would have said. So intersect each list against the extracted
 * PARAM_KEYS and drop what nothing reads. A method whose requires vanish entirely
 * keeps no gate — the editor's own 400 is a better teacher than a wrong local one.
 *
 *   node scripts/align-requires.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataPath = join(repo, 'src', 'catalog', 'method-data.ts')
const catalogPath = join(repo, 'src', 'catalog', 'methods.ts')
const check = process.argv.includes('--check')

const dataText = readFileSync(dataPath, 'utf8')
// The generated file annotates each export (`const X: Readonly<…> = {`) and does
// not use `as const`, so match both forms. An earlier version required `as const`
// and threw `Cannot read properties of null` on every run.
const block = new RegExp('PARAM_KEYS(?::[^=]*)? = \\{([\\s\\S]*?)\\n\\}').exec(dataText)[1]
const params = {}
for (const entry of block.matchAll(/"([^"]+)": \[([^\]]*)\]/g)) {
  params[entry[1]] = new Set(entry[2].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean))
}
const unresolved = new Set(
  JSON.parse(
    /PARAMS_UNRESOLVED(?::[^=]*)? = (\[[\s\S]*?\])\s*;?\s*\n/.exec(dataText)[1].replace(/,\s*\]$/, ']'),
  ),
)

const catalog = readFileSync(catalogPath, 'utf8')
const lines = catalog.split('\n')
const dropped = []
let current = null

/** Collapse an object literal left with a dangling comma by a removed property. */
const tidy = text =>
  text
    .replace(/\{\s*,\s*\}/g, '{}')
    .replace(/\{\s*,\s*/g, '{ ')
    .replace(/,\s*\}/g, ' }')
    .replace(/\{\s*\}/g, '{}')
    .replace(/\(\s*,\s*\)/g, '()')

const out = lines.map(line => {
  const key = /^\s{2}(?:'([^']+)'|"([^"]+)"|([a-z_][a-z0-9_.]*\.[a-z_][a-z0-9_.]*))\s*:\s*(?:read|write|destroy|danger)\(/.exec(line)
  if (key) current = key[1] ?? key[2] ?? key[3]
  if (!current) return line

  // A catalog entry is usually written on ONE line, so `requires` must be checked
  // on the same line the method name appeared on. Skipping it there (as an earlier
  // version did, by returning as soon as a key matched) left ~95 entries unvalidated
  // and reported a clean run: only the three multi-line entries were ever examined.
  const req = /(requires:\s*\[)([^\]]*)(\])/.exec(line)
  if (!req) return line
  // An unresolved handler means we do not know its keys; keeping the hand-written
  // requires there is right, since dropping it would remove a real gate.
  if (unresolved.has(current)) return line
  const known = params[current]
  if (!known) return line

  const names = req[2]
    .split(',')
    .map(s => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
  const kept = names.filter(name => known.has(name))
  if (kept.length === names.length) return line

  dropped.push(`${current}: dropped ${names.filter(n => !kept.includes(n)).join(', ')}`)
  if (kept.length === 0) {
    // Remove the property outright, then repair the literal it left behind.
    return tidy(line.replace(/requires:\s*\[[^\]]*\],?/, '').replace(/,\s*(\}\s*\)|\))/, '$1'))
  }
  return line.replace(req[0], `${req[1]}${kept.map(n => `'${n}'`).join(', ')}${req[3]}`)
})

if (dropped.length === 0) console.log('every requires is backed by a key the handler reads')
else {
  console.log(`${dropped.length} catalog entries had unverifiable required keys:`)
  for (const row of dropped) console.log(`  ${row}`)
}
if (!check) writeFileSync(catalogPath, out.join('\n'), 'utf8')
else console.log('--check: not written')
