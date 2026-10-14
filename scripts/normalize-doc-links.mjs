/**
 * Normalize the relative links in the body of every documentation file.
 *
 * The 37 documentation files link to each other constantly: a README points at its four
 * topic docs, a topic doc points back at the README and sideways at its siblings, and the
 * language bars point at the same document in eight other languages. Every one of those
 * links is a relative path, which means every one depends on how deep the file doing the
 * linking happens to be.
 *
 * Translators get that wrong, and they get it wrong in the same direction every time: they
 * write the link that reads correctly from the English original. So `docs/readme/README_zh.md`
 * linked `zh/01-tutorial.md`, which resolves to `docs/readme/zh/01-tutorial.md` — a path
 * that does not exist — because the English `docs/01-tutorial.md` links `zh/01-tutorial.md`
 * and that link *is* correct from `docs/`. The root README had the mirror-image version of
 * the same disease, `../docs/01-tutorial.md`.
 *
 * So links are derived here too, from a canonical inventory of the 37 files, and this
 * script is idempotent. `tests/i18n.test.ts` is what proves the result: it fails on every
 * link that does not resolve, so this script and that test can be run against each other
 * until they agree.
 *
 *   node scripts/normalize-doc-links.mjs           # rewrite every body link
 *   node scripts/normalize-doc-links.mjs --check   # exit 1 if any link is not canonical
 *
 * Three deliberate limits:
 *
 *   - Only links whose *basename* names one of the 37 inventory files are touched. A link
 *     to `package.json` or to a GitHub issue is somebody's content and stays as written.
 *
 *   - Only the body is touched — everything up to and including the closing `</div>` of
 *     the header block. The header is owned by `normalize-doc-headers.mjs`, and rewriting
 *     it here would fight with that script: `[English](../../README.md)` in a README
 *     translation really does mean the root README, not the file's own translation.
 *
 *   - The *target language* of a link is whatever language directory the link path names,
 *     and falls back to the language of the file it sits in. That is how a README linking
 *     `01-tutorial.md` with no prefix is read as "this README's language", while a link to
 *     `ko/01-tutorial.md` is read as Korean regardless of who is writing it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LANGUAGES, readmeOf } from './languages.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

const TOPIC_DOCS = ['01-tutorial.md', '02-protocol.md', '03-architecture.md', 'command-reference.md']

/** Every documentation file, as a repo-root-relative path. */
const INVENTORY = new Set([
  ...LANGUAGES.map((l) => readmeOf(l)),
  ...LANGUAGES.flatMap((l) => TOPIC_DOCS.map((doc) => (l.dir === '' ? `docs/${doc}` : `docs/${l.dir}/${doc}`))),
])

/** Language directory segments, e.g. `zh`, `zh-TW`, `ja`. */
const LANG_SEGMENTS = new Set(LANGUAGES.filter((l) => l.dir !== '').map((l) => l.dir))

/** Basenames that name a file in the inventory. */
const DOC_BASENAMES = new Set([...TOPIC_DOCS, ...LANGUAGES.map((l) => readmeOf(l)).map((p) => basename(p))])

const dirOf = (p) => {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/** The language a file belongs to. */
const langOfFile = (rel) => {
  if (rel === 'README.md') return LANGUAGES.find((l) => l.dir === '') ?? LANGUAGES[0]
  if (rel.startsWith('docs/readme/')) return LANGUAGES.find((l) => readmeOf(l) === rel) ?? LANGUAGES[0]
  const seg = rel.split('/')[1] ?? ''
  return LANGUAGES.find((l) => l.dir === seg) ?? LANGUAGES[0]
}

/** The canonical repo-root path for a doc link, given its basename and target language. */
const canonicalFor = (basenameStr, targetLang) => {
  if (basenameStr === 'README.md') return 'README.md'
  if (/^README_.*\.md$/.test(basenameStr)) return `docs/readme/${basenameStr}`
  return targetLang.dir === '' ? `docs/${basenameStr}` : `docs/${targetLang.dir}/${basenameStr}`
}

/**
 * The target language of a doc link: the first path segment naming a language directory,
 * or the language of the file doing the linking when the link carries no such segment.
 */
const langOfLink = (linkPath, currentLang) => {
  for (const seg of linkPath.split('/')) {
    if (LANG_SEGMENTS.has(seg)) return LANGUAGES.find((l) => l.dir === seg) ?? currentLang
  }
  return currentLang
}

/** POSIX relative link from one directory to one file. */
const relativePath = (fromDir, to) => {
  const from = fromDir === '' ? [] : fromDir.split('/')
  const toParts = to.split('/')
  let shared = 0
  while (shared < from.length && shared < toParts.length && from[shared] === toParts[shared]) shared += 1
  return [...Array(from.length - shared).fill('..'), ...toParts.slice(shared)].join('/')
}

const CODE_FENCE = /^\s*(```|~~~)/
const LINK_RE = /(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

const targets = [...INVENTORY].sort()

const rewritten = targets.map((rel) => {
  const path = join(repo, rel)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { rel, path, next: null, missing: true, fixed: 0 }
  }
  const lines = text.split('\n')
  const bodyStart = lines.findIndex((l) => l.trim() === '</div>') + 1
  const lang = langOfFile(rel)
  let fixed = 0
  let fenced = false
  for (let i = Math.max(bodyStart, 0); i < lines.length; i += 1) {
    const line = lines[i]
    if (CODE_FENCE.test(line)) fenced = !fenced
    if (fenced) continue
    lines[i] = line.replace(LINK_RE, (whole, label, target) => {
      if (/^(https?:|mailto:|#)/.test(target)) return whole
      const hashAt = target.indexOf('#')
      const linkPath = (hashAt < 0 ? target : target.slice(0, hashAt)).trim()
      const anchor = hashAt < 0 ? '' : target.slice(hashAt)
      const b = basename(linkPath)
      if (!DOC_BASENAMES.has(b)) return whole
      const canonical = canonicalFor(b, langOfLink(linkPath, lang))
      const next = `${relativePath(dirOf(rel), canonical)}${anchor}`
      if (next === target) return whole
      fixed += 1
      return `[${label}](${next})`
    })
  }
  const next = lines.join('\n')
  return { rel, path, next: next === text ? null : next, missing: false, fixed }
})

const stale = rewritten.filter((r) => r.next !== null)
const absent = rewritten.filter((r) => r.missing).map((r) => r.rel)

// A missing file means the language set is incomplete: `--check` must fail, because that is
// how `npm run check` learns a translation was never started. A plain run just skips it, so
// the normalizer stays usable while translations are still landing.
if (check && absent.length > 0) {
  console.error(`no file to normalize: ${absent.join(', ')}`)
  process.exit(1)
}

if (check) {
  if (stale.length > 0) {
    console.error(`links are not canonical in ${stale.length} file(s):\n  ${stale.map((r) => r.rel).join('\n  ')}`)
    console.error('  run: node scripts/normalize-doc-links.mjs')
    process.exit(1)
  }
  console.log(`doc links are canonical in ${targets.length} files`)
} else {
  for (const r of stale) writeFileSync(r.path, r.next, 'utf8')
  const skipped = absent.length > 0 ? ` (${absent.length} not written yet)` : ''
  console.log(
    stale.length === 0
      ? `doc links already canonical in ${targets.length - absent.length} files${skipped}`
      : `fixed links in ${stale.length} of ${targets.length} files${skipped}`,
  )
}
