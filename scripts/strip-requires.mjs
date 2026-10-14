/**
 * Strip hand-written `requires` from `catalog/methods.ts`.
 *
 * The gate now comes from `REQUIRED_KEYS` in the generated data — the keys the
 * plugin itself demands, harvested from its own `SendError(…, 400,
 * TEXT("Missing field: X"))` messages. Hand-guessing mandatory keys produced 50
 * wrong entries in the first draft (`asset_path` where the handler reads `path`,
 * `bounds` where it reads `graph_path`, `mode` where it reads `yaw`), and each one
 * of those would have made the bridge REJECT A VALID CALL before the engine saw it
 * — the caller gets a confident false claim instead of the engine's real error.
 *
 *   node scripts/strip-requires.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = join(repo, 'src', 'catalog', 'methods.ts')

const source = readFileSync(catalogPath, 'utf8')
let removed = 0

// `{ requires: ['a'], … }` → drop the property, then repair the object literal so
// the result is still parseable: `{ a: 1, }`, `{, a: 1}`, and `{}` all need tidying.
const withoutRequires = source.replace(/requires:\s*\[[^\]]*\],?\s*/g, match => {
  removed += 1
  return ''
})

const tidy = text =>
  text
    // A trailing property left behind: `…,  }` / `…,  })`.
    .replace(/,\s*,/g, ',')
    // The removals leave `, }` and `, })` wherever `requires` was the last entry.
    .replace(/,\s*\}/g, ' }')
    // An empty object literal, or one with only a comma.
    .replace(/\{\s*,?\s*\}/g, '{}')
    // A leading comma from removing the first property.
    .replace(/\(\s*,/g, '(')
    .replace(/\{\s*,\s*/g, '{ ')
    // Two consecutive spaces the removals introduced inside an arg list.
    .replace(/\(\s{2,}/g, '(')
    .replace(/ {2,}\)/g, ')')

const output = tidy(withoutRequires)
writeFileSync(catalogPath, output, 'utf8')
console.log(`removed ${removed} hand-written requires clause(s) from src/catalog/methods.ts`)
