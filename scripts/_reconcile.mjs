/**
 * Ad-hoc drift check: catalog keys vs the methods the plugin registers.
 *
 * Superseded by `scripts/check-catalog.mjs` (which also validates `requires` and
 * is what `npm run check` runs), but kept because it reads `method-data.ts` and
 * `methods.ts` with a different regex than the checker does — two independent
 * parses disagreeing is itself the signal.
 *
 *   node scripts/_reconcile.mjs
 */
import { readFileSync } from 'node:fs'
const data = readFileSync('src/catalog/method-data.ts','utf8')
// The generated file annotates the export and no longer uses `as const`.
const arr = /UAL_REGISTERED_METHODS(?::[^=]*)? = (\[[\s\S]*?\])\s*;?\s*\n/.exec(data)[1]
const real = JSON.parse(arr.replace(/,\s*\]$/,']'))
const cat = readFileSync('src/catalog/methods.ts','utf8')
const keys = [...cat.matchAll(/^\s{2}(?:'([^']+)'|([a-z_]+\.[a-z_]+)|"([^"]+)"):\s(?:read|write|destroy|danger)\(/gm)].map(m=>m[1]||m[2]||m[3])
const drift = keys.filter(k=>!real.includes(k))
const missing = real.filter(r=>!keys.includes(r))
console.log('catalog entries:', keys.length, 'real:', real.length)
console.log('DRIFT (in catalog, not upstream): '+drift.length); drift.forEach(d=>console.log('  - '+d))
console.log('UNCATALOGED (upstream, not in catalog): '+missing.length); missing.forEach(m=>console.log('  + '+m))
