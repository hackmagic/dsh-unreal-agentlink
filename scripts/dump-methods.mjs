/**
 * Print the authoritative method table, straight from the generated data.
 *
 * Used while writing `catalog/methods.ts` so every summary, required key, and
 * risk call is checked against the extracted names rather than against memory or
 * against the plugin's documentation (which is stale in several places).
 *
 *   node scripts/dump-methods.mjs            # everything
 *   node scripts/dump-methods.mjs material.  # one family
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(repo, 'src', 'catalog', 'method-data.ts'), 'utf8')

// The generated file annotates each export (`const X: Readonly<…> = {`) and does
// not use `as const`, so both forms must be matched or the tables read as empty —
// which presents as "0 methods registered", indistinguishable from a bad source
// path, so the length check below is what catches that class of mistake.
const array = name => {
  const found = new RegExp(`${name}(?::[^=]*)? = (\\[[\\s\\S]*?\\])\\s*;?\\s*\\n`).exec(text)
  return found ? JSON.parse(found[1].replace(/,\s*\]$/, ']')) : []
}
const table = varName => {
  const block = new RegExp(`${varName}(?::[^=]*)? = \\{([\\s\\S]*?)\\n\\}`).exec(text)
  if (!block) return {}
  const out = {}
  for (const entry of block[1].matchAll(/"([^"]+)": \[([^\]]*)\]/g)) {
    out[entry[1]] = entry[2]
      .split(',')
      .map(item => item.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
  }
  return out
}

const methods = array('UAL_REGISTERED_METHODS')
const params = table('PARAM_KEYS')
const results = table('RESULT_KEYS')
const codes = table('METHOD_CODES')
const required = table('REQUIRED_KEYS')
const unresolved = array('PARAMS_UNRESOLVED')

if (methods.length === 0) {
  console.error('parsed zero methods out of src/catalog/method-data.ts — regenerate it first')
  process.exit(1)
}

const filter = process.argv[2]
const shown = methods.filter(method => !filter || method.includes(filter))

console.log(`registered: ${methods.length}   showing: ${shown.length}   params-unresolved: ${unresolved.length}`)
for (const method of shown) {
  const p = params[method] ?? []
  const r = results[method] ?? []
  const c = codes[method] ?? []
  const req = required[method] ?? []
  const flag = unresolved.includes(method) ? '  [PARAMS NOT EXTRACTED]' : ''
  console.log(`\n### ${method}${flag}`)
  console.log(`  IN     : ${p.join(', ') || (unresolved.includes(method) ? '(unknown)' : '(none)')}`)
  console.log(`  REQUIRE: ${req.join(', ') || '(none proven)'}`)
  console.log(`  OUT    : ${r.join(', ') || '(none seen)'}`)
  console.log(`  CODES  : ${c.join(' ') || '(none seen)'}`)
}
