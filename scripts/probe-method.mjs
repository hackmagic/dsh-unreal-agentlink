/**
 * Ad-hoc inspector: dump the param/result keys the plugin reads for one method.
 *
 * Used while writing the catalog to check a key name against the C++ instead of
 * against its documentation — several doc examples disagree with the handler.
 *
 *   node scripts/probe-method.mjs actor.spawn
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sources = process.argv[2 + 1] ?? '.ua-ref/plugin/UnrealAgentLink/Source'
const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/probe-method.mjs <method> [sourceRoot]')
  process.exit(1)
}

const files = []
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (entry.endsWith('.cpp')) files.push(full)
  }
}
walk(sources)

const KEYS = pattern => body => [...new Set([...body.matchAll(new RegExp(pattern, 'g'))].map(m => m[1]))].sort()
const reads = KEYS(/TryGet(?:String|Number|Integer|Bool|Object|Array)\w*Field\(\s*TEXT\(\s*"([^"]+)"/)
const writes = KEYS(/Set(?:String|Number|Bool|Object|Array|NumberField)\(\s*TEXT\(\s*"([^"]+)"/)
const codes = body => [...new Set([...body.matchAll(/Send(?:Error|Response)\([^,]+,\s*(\d{3})/g)].map(m => m[1]))].sort((a, b) => a - b)

let found = false
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const at = text.indexOf(`"${target}"`)
  if (at < 0) continue
  found = true
  const tail = text.slice(at, at + 900)
  const handler = /Handle_[A-Za-z0-9_]+/.exec(tail)?.[0]
  // Inline lambda body, brace balanced.
  let body = ''
  const open = text.indexOf('{', at)
  if (open >= 0) {
    let depth = 0
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1
      else if (text[index] === '}') {
        depth -= 1
        if (depth === 0) {
          body = text.slice(open, index + 1)
          break
        }
      }
    }
  }
  console.log(`### ${target}  (${file.split(/[\\/]/).pop()}), handler=${handler ?? 'inline'}`)
  console.log(`  IN   : ${reads(body).join(', ') || '(none in the lambda — it may delegate)'}`)
  console.log(`  OUT  : ${writes(body).join(', ')}`)
  console.log(`  CODES: ${codes(body).join(' ')}`)
  if (handler) {
    for (const other of files) {
      const otext = readFileSync(other, 'utf8')
      const olines = otext.split('\n')
      for (let i = 0; i < olines.length; i += 1) {
        if (!olines[i].includes(`${handler}(`)) continue
        if (!/^\s*(?:static\s+)?[\w:<>,\s*&]*\b/.test(olines[i])) continue
        let depth = 0
        let started = false
        const out = []
        for (let line = i; line < Math.min(olines.length, i + 1200); line += 1) {
          out.push(olines[line])
          for (const char of olines[line]) {
            if (char === '{') {
              depth += 1
              started = true
            } else if (char === '}') depth -= 1
          }
          if (started && depth <= 0) break
        }
        const hbody = out.join('\n')
        console.log(`  -- resolved ${handler} in ${other.split(/[\\/]/).pop()}`)
        console.log(`     IN   : ${reads(hbody).join(', ')}`)
        console.log(`     OUT  : ${writes(hbody).join(', ')}`)
        console.log(`     CODES: ${codes(hbody).join(' ')}`)
        break
      }
    }
  }
}
if (!found) console.error(`"${target}" is not registered anywhere under ${sources}`)
