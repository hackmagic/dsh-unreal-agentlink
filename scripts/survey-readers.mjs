/**
 * Enumerate the shapes by which a UAL handler reads a parameter key, so the
 * extractor's read-pattern list covers the real ones instead of the guessed ones.
 *
 *   node scripts/survey-readers.mjs
 *
 * This exists because `locks.set` came back with only `level_locked`: its `paths`
 * and `enforced` are read through a local `ReadStringArray(TEXT("paths"), …)`
 * helper, which no `TryGet*Field` regex can see. Rather than add one more guessed
 * pattern, look at every call that passes a `TEXT("…")` literal into something.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sources = '.ua-ref/plugin/UnrealAgentLink/Source/UnrealAgentLink/Private'
const files = []
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (entry.endsWith('.cpp')) files.push(full)
  }
}
walk(sources)

const seen = new Map()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  // Any `Name(TEXT("key")` occurrence, minus the writes we already model.
  for (const match of text.matchAll(/\b([A-Za-z_][\w]*)\s*\(\s*TEXT\(\s*"([a-z0-9_]+)"\s*\)/g)) {
    const fn = match[1]
    if (/^Set(STRING|Number|Bool|Object|Array|String)/i.test(fn)) continue
    if (fn === 'TEXT') continue
    if (!seen.has(fn)) seen.set(fn, new Set())
    seen.get(fn).add(match[2])
  }
}

const rows = [...seen.entries()].sort((a, b) => b[1].size - a[1].size)
console.log('function(<n> distinct keys) — the ones with many keys are param readers:')
for (const [fn, keys] of rows.slice(0, 25)) {
  console.log(`  ${fn.padEnd(34)} ${String(keys.size).padStart(4)}   e.g. ${[...keys].slice(0, 6).join(', ')}`)
}
