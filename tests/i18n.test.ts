import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { LANGUAGES } from '../scripts/languages.mjs'

/**
 * The documentation is published in 9 languages. Every translation is a separate
 * hand-written file, and every one of them carries its own language-switcher bar and
 * its own set of internal links. A translation that forgets a language in the bar, or
 * links to a heading it renamed, is a defect a reader hits immediately and that no
 * other test file in this project would notice — the tests under `tests/` exercise
 * `src/`, and `src/` knows nothing about `docs/`.
 *
 * So these tests read the docs as data and check the things a reader would trip on:
 *
 *   - every language has the files we claim it has;
 *   - every language directory holds only the files we know about;
 *   - every switcher bar lists every language, and bolds exactly one (its own);
 *   - every relative link resolves to a file that exists;
 *   - every `#anchor` resolves to a heading in the file it points at.
 *
 * The last one is the reason this file exists. Anchors are computed from the
 * *translated* heading text, so a translator who rewords "Verification strategy"
 * silently invalidates every link that pointed at it. GitHub gives no error — the
 * link just does not scroll. `gen-docs.mjs --check` guards the generated command
 * references, but the three hand-translated topic docs per language are unguarded
 * without this.
 *
 * The first one is the reason this file grew. When the AI-readable install guide was
 * added, it reached English and Simplified Chinese first; the other seven languages
 * arrived later, and for that whole window the suite stayed green, because the guide
 * was absent from `FILES` and merely *allowed* by the stray-file test. Two defects
 * in one: a permission read as a requirement, and a file list that had to be edited by
 * hand every time a document was added. `SHARED_DOCS` now joins the other lists, so a
 * new shared document is checked the moment it is declared.
 *
 * `LANGUAGES` comes from `scripts/languages.mjs` rather than a local copy, so adding a
 * language in one place is adding it in all of them.
 *
 * Every reader here degrades to an empty result on a missing or non-file path, so a
 * half-finished translation reports a list of missing files rather than crashing on
 * `ENOENT` and hiding the rest.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TOPIC_DOCS = ['01-tutorial.md', '02-protocol.md', '03-architecture.md'] as const
const GENERATED = 'command-reference.md'
/**
 * Files that are not translations and not generated, so they live beside the canonical docs
 * and must exist in every language. `INSTALL-ai.md` is the newest one: the English and
 * Simplified-Chinese copies were written first, and the other seven landed later — during
 * which time this file was only a *permission* in the stray-file test below, so a missing
 * translation was invisible. A file in this list is therefore checked for existence, for its
 * switcher bar, and for its links, exactly like a topic doc.
 */
const SHARED_DOCS = ['INSTALL-ai.md'] as const

/** Where the README for a language lives, relative to the repo root. */
const readmeOf = (lang) => (lang.dir === '' ? 'README.md' : `docs/readme/README_${lang.code}.md`)

interface DocFile {
  lang: (typeof LANGUAGES)[number]
  path: string
  rel: string
}

const FILES: DocFile[] = LANGUAGES.flatMap((lang) => [
  { lang, path: join(ROOT, readmeOf(lang)), rel: readmeOf(lang) },
  ...[...TOPIC_DOCS, ...SHARED_DOCS, GENERATED].map((doc) => ({
    lang,
    rel: lang.dir === '' ? `docs/${doc}` : `docs/${lang.dir}/${doc}`,
    path: join(ROOT, lang.dir === '' ? 'docs' : `docs/${lang.dir}`, doc),
  })),
])

/** Read a file as text, or '' when it is missing or is not a file. */
const read = (path: string): string => {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

/** Markdown links: `[label](target)` and `[label](target#anchor)`, excluding images. */
const LINK_RE = /(?<!!)\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

interface Link {
  label: string
  target: string
}

/** Every link in a file, split into a path and an optional anchor. */
const linksOf = (path: string): Link[] =>
  [...read(path).matchAll(LINK_RE)].map((m) => ({
    label: m[0].slice(1, m[0].indexOf(']')),
    target: m[1] ?? '',
  }))

/**
 * GitHub's anchor rule: lowercase, drop everything that is not a letter, digit, space
 * or hyphen, then turn runs of whitespace into single hyphens. CJK and accented Latin
 * are letters and survive, which is why translating a heading changes its anchor.
 */
const anchorOf = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-]/gu, '')
    .replace(/\s+/g, '-')

/** Every heading anchor a file declares, including duplicates (GitHub appends -1, -2, …). */
const headingsOf = (path: string): Set<string> => {
  const found = new Set<string>()
  const seen = new Map<string, number>()
  for (const line of read(path).split('\n')) {
    const m = /^#{1,6}\s+(.*?)\s*$/.exec(line)
    if (!m) continue
    const base = anchorOf(m[1] ?? '')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    found.add(n === 0 ? base : `${base}-${n}`)
  }
  return found
}

/** True when a path exists and is a regular file — a directory target is a broken link. */
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

describe('documentation layout', () => {
  it('has a file for every language', () => {
    const missing = FILES.filter((f) => !isFile(f.path)).map((f) => f.rel)
    expect(missing).toEqual([])
  })

  it('holds only the files we know about in each language directory', () => {
    // A stray file in `docs/ja/` is almost always a leftover from a rename, and it will
    // be linked from nowhere and read by nobody. Cheap to catch, cheap to miss.
    //
    // The shared install guide is a known file, not an exception: every language directory
    // carries exactly one, so nothing extra is allowed. The line below used to *permit*
    // it instead of requiring it, which is how seven languages went missing while the
    // suite stayed green.
    const expected = (lang) =>
      new Set([...TOPIC_DOCS, ...SHARED_DOCS, GENERATED].map((doc) => `docs/${lang.dir}/${doc}`))
    const strays = LANGUAGES.filter((l) => l.dir !== '').flatMap((lang) => {
      let actual: string[] = []
      try {
        actual = readdirSync(join(ROOT, 'docs', lang.dir))
      } catch {
        return [`docs/${lang.dir}/ (unreadable)`]
      }
      const want = expected(lang)
      return actual.filter((name) => !want.has(`docs/${lang.dir}/${name}`)).map((n) => `docs/${lang.dir}/${n}`)
    })
    expect(strays).toEqual([])
  })

  it('declares every language in every switcher bar', () => {
    // Only the first ~4 KB is read: the switcher sits at the very top of every file, and
    // scanning the whole thing would let a chance mention of "English" in prose pass.
    // Files that do not exist yet are skipped — "has a file for every language" above is
    // the test that reports a missing translation, and reporting it three more times here
    // would just bury it in noise.
    const incomplete = FILES.filter((f) => isFile(f.path)).filter((f) =>
      LANGUAGES.some((l) => !read(f.path).slice(0, 4000).includes(l.label)),
    ).map((f) => f.rel)
    expect(incomplete).toEqual([])
  })

  it('bolds exactly one language per file, and it is its own', () => {
    // rea's convention: the current language is bold and unlinked, every other one is a link.
    // A file that bolds none has a dead bar; one that bolds two is ambiguous to read.
    const wrong = FILES.filter((f) => isFile(f.path)).flatMap((f) => {
      const bar = read(f.path).slice(0, 4000)
      const bolded = LANGUAGES.filter((l) => bar.includes(`**${l.label}**`)).map((l) => l.code)
      return bolded.length === 1 && bolded[0] === f.lang.code
        ? []
        : [`${f.rel}: bolded ${JSON.stringify(bolded)}, expected [${f.lang.code}]`]
    })
    expect(wrong).toEqual([])
  })
})

describe('documentation links', () => {
  it('resolves every relative link to a file that exists', () => {
    const broken = FILES.filter((f) => isFile(f.path)).flatMap((f) =>
      linksOf(f.path)
        .filter((l) => !/^(https?:|mailto:)/.test(l.target))
        // `#heading` with no path is a same-page link: its target is the file itself, which
        // the anchor tests below own. Treating it here would report every nav link as
        // broken and bury the real misses.
        .filter((l) => l.target.split('#')[0] !== '')
        .map((l) => ({ ...l, resolved: resolve(dirname(f.path), l.target.split('#')[0] ?? '') }))
        .filter((l) => !isFile(l.resolved))
        .map((l) => `${f.rel}: [${l.label}] → ${l.target}`),
    )
    expect(broken).toEqual([])
  })

  it('resolves every in-document anchor to a real heading', () => {
    const broken = FILES.filter((f) => isFile(f.path)).flatMap((f) =>
      linksOf(f.path)
        .filter((l) => l.target.includes('#') && !/^(https?:|mailto:)/.test(l.target))
        .flatMap((l) => {
          const [path, anchor] = l.target.split('#')
          const resolved = resolve(dirname(f.path), path ?? '')
          if (!isFile(resolved)) return [] // already reported by the test above
          return headingsOf(resolved).has((anchor ?? '').toLowerCase())
            ? []
            : [`${f.rel}: [${l.label}] → ${l.target}`]
        }),
    )
    expect(broken).toEqual([])
  })

  it('resolves every same-page anchor to a real heading', () => {
    // `[label](#heading)` with no matching heading in the same file.
    const dangling = FILES.filter((f) => isFile(f.path)).flatMap((f) =>
      linksOf(f.path)
        .filter((l) => l.target.startsWith('#'))
        .filter((l) => !headingsOf(f.path).has(l.target.slice(1).toLowerCase()))
        .map((l) => `${f.rel}: [${l.label}] → ${l.target}`),
    )
    expect(dangling).toEqual([])
  })
})

describe('generated command reference', () => {
  it('is not stale in any language', () => {
    // Re-running the generator must produce byte-identical files. Anything else means a
    // source changed and the checked-in copies went stale — the same contract
    // `check-catalog.mjs` enforces for the catalog. Delegated to the generator rather
    // than re-implemented here, so there is one renderer and one staleness rule.
    //
    // `stdio: 'inherit'` rather than the default 'pipe': capturing another process's
    // output through piped stdio is refused in confined Windows sandboxes, and there is
    // nothing to read anyway — the generator prints what it wants us to see.
    try {
      execFileSync(process.execPath, ['scripts/gen-docs.mjs', '--check'], { cwd: ROOT, stdio: 'inherit' })
    } catch (error) {
      const code = (error as { status?: number }).status
      throw new Error(`command reference is stale (exit ${code}) — run 'npm run build && node scripts/gen-docs.mjs'`)
    }
  })
})
