/**
 * Normalize the header block of every documentation file: the language switcher bar and
 * the doc-navigation line.
 *
 * Every one of the doc files opens with a bar that lists all nine languages and a nav
 * line that lists the four documents. Those bars are mechanical — the same nine labels,
 * the same relative paths, in the same order, in every file — but they were written by
 * hand in each translation, and hand-written mechanical text drifts. The German
 * translation, for instance, linked its own language instead of bolding it, which is
 * exactly the defect `tests/i18n.test.ts` now reports.
 *
 * So the bars are derived here rather than hand-maintained, and this script is
 * idempotent: run it as often as you like.
 *
 * What it rewrites:
 *
 *   - the language bar, from `scripts/languages.mjs` — the current language is bold and
 *     unlinked, every other one is a link to its sibling file. Paths are computed with
 *     `path.relative`, so the root README, a README translation, an English topic doc and
 *     a translated topic doc each get the right prefix without a special case.
 *
 *   - the doc-nav line, keeping each translation's own labels. It finds which nav item
 *     points at the file it is currently in and bolds that one, so the "you are here"
 *     marker is correct without anyone having to think about it.
 *
 * What it deliberately leaves alone: the translated labels themselves, and everything
 * below the header. A normalizer that also rewrote prose would be a translator.
 *
 *   node scripts/normalize-doc-headers.mjs           # rewrite every header
 *   node scripts/normalize-doc-headers.mjs --check   # exit 1 if any header is not canonical
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LANGUAGES, readmeOf } from './languages.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

const TOPIC_DOCS = ['01-tutorial.md', '02-protocol.md', '03-architecture.md', 'command-reference.md']

/** POSIX path join — `join` from `node:path` is backslash on Windows, which is wrong in a link. */
const posix = (...parts) => parts.join('/').replace(/\/+/g, '/').replace(/(^|\/)\.\//g, '$1')
/** Repo-root-relative, forward-slashed form of a path, with `.` and `..` collapsed. */
const norm = (p) => posix(...p.split('\\').join('/').split('/').filter((s) => s !== '' && s !== '.'))

/** Every file with a header, as a repo-root-relative path. */
const targets = [
  'README.md',
  ...LANGUAGES.filter((l) => l.dir !== '').map((l) => readmeOf(l)),
  ...LANGUAGES.flatMap((l) => TOPIC_DOCS.map((doc) => (l.dir === '' ? `docs/${doc}` : `docs/${l.dir}/${doc}`))),
]

/** A README — the root one or any translation — as opposed to a topic document. */
const isReadme = (at) => at === 'README.md' || at.startsWith('docs/readme/')

/**
 * Link from one repo-relative DIRECTORY to one repo-relative file, in POSIX form. `from`
 * must be a directory: `path.relative` does not strip a trailing segment, so passing a
 * file path silently prefixes every link with a stray `../`.
 */
const link = (fromDir, to) => relative(fromDir, to).split('\\').join('/')

/** Where the same document lives in another language. */
const siblingOf = (at, lang) => {
  if (isReadme(at)) return readmeOf(lang)
  const name = basename(at)
  return lang.dir === '' ? `docs/${name}` : `docs/${lang.dir}/${name}`
}

/** The language bar for the file at `at`, relative to the repo root. */
const barOf = (at) =>
  LANGUAGES.map((lang) => {
    const sibling = siblingOf(at, lang)
    return norm(sibling) === norm(at) ? `**${lang.label}**` : `[${lang.label}](${link(dirname(at), sibling)})`
  }).join(' · ')

/**
 * The doc-nav line, with the current document bolded. Labels are read out of the existing
 * line rather than translated here, so each translation keeps its own words.
 */
const navOf = (at, line) => {
  const items = [...line.matchAll(/(?:\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\))/g)].map((m) => ({
    label: m[1] ?? m[2] ?? '',
    target: m[3] ?? '',
  }))
  if (items.length === 0) return line.trim()
  return items
    .map(({ label, target }) => {
      // An already-bolded item has no target; a linked one is "here" when it resolves back
      // to the file it sits in — which also corrects a translator who linked instead of
      // bolding.
      const isHere = target === '' || norm(join(dirname(at), target)) === norm(at)
      return isHere ? `**${label}**` : `[${label}](${target})`
    })
    .join(' · ')
}

const rewritten = targets.map((rel) => {
  const path = join(repo, rel)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { rel, path, next: null, missing: true, unparsed: false }
  }
  const lines = text.split('\n')
  const div = lines.findIndex((l) => l.trim() === '<div align="center">')
  if (div < 0) return { rel, path, next: null, missing: false, unparsed: true }
  // The bar is the first non-empty line after the opening `<div>`; the nav line, when the
  // document has one, is the next. Anything else inside the block — a badge, a tagline —
  // is left untouched, which is why the bar and nav are replaced line by line rather than
  // as one blob.
  const bar = div + 1 + lines.slice(div + 1).findIndex((l) => l.trim() !== '')
  const nav = bar + 1 + lines.slice(bar + 1).findIndex((l) => l.trim() !== '')
  const hasNav = !isReadme(rel) && nav > bar && nav < lines.length && lines[nav].trim() !== '</div>'
  lines[bar] = barOf(rel)
  if (hasNav) lines[nav] = navOf(rel, lines[nav])
  const next = lines.join('\n')
  return { rel, path, next: next === text ? null : next, missing: false, unparsed: false }
})

const stale = rewritten.filter((r) => r.next !== null)
const absent = rewritten.filter((r) => r.missing).map((r) => r.rel)
const unheadered = rewritten.filter((r) => !r.missing && r.next === null && r.unparsed).map((r) => r.rel)

// A missing file means the language set is incomplete: `--check` must fail, because that is
// how `npm run check` learns a translation was never started. A plain run just skips it, so
// the normalizer stays usable while translations are still landing.
if (check && absent.length > 0) {
  console.error(`no file to normalize: ${absent.join(', ')}`)
  process.exit(1)
}

if (check) {
  if (stale.length > 0) {
    console.error(`header is not canonical in ${stale.length} file(s):\n  ${stale.map((r) => r.rel).join('\n  ')}`)
    console.error('  run: node scripts/normalize-doc-headers.mjs')
    process.exit(1)
  }
  if (unheadered.length > 0) {
    console.error(`no language bar found in ${unheadered.length} file(s):\n  ${unheadered.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`doc headers are canonical in ${targets.length} files`)
} else {
  for (const r of stale) writeFileSync(r.path, r.next, 'utf8')
  const skipped = absent.length > 0 ? ` (${absent.length} not written yet)` : ''
  console.log(
    stale.length === 0
      ? `doc headers already canonical in ${targets.length - absent.length} files${skipped}`
      : `normalized ${stale.length} of ${targets.length} doc headers${skipped}`,
  )
}
