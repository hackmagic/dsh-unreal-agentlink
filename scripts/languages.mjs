/**
 * The language set the documentation is published in — the single source of truth.
 *
 * Three consumers read this list: `scripts/gen-docs.mjs` (to write one command
 * reference per language), `tests/i18n.test.ts` (to assert every language has its
 * files, a complete switcher bar, and resolvable links), and `scripts/check-docs.mjs`
 * (to assert the generated files are not stale). When they each kept their own copy,
 * adding a language meant finding all three by hand — and a language the generator
 * writes but the tests never check is a language nobody verifies.
 *
 * `dir` is `''` for the canonical English copy, which lives at `docs/` directly rather
 * than `docs/en/`. That keeps the URLs stable for the language most readers land on,
 * and mirrors how the upstream project this layout follows does it.
 */

/** @typedef {{ code: string, label: string, dir: string }} Language */

/** @type {ReadonlyArray<Language>} */
export const LANGUAGES = [
  { code: 'en', label: 'English', dir: '' },
  { code: 'zh', label: '简体中文', dir: 'zh' },
  { code: 'zh-TW', label: '繁體中文', dir: 'zh-TW' },
  { code: 'ja', label: '日本語', dir: 'ja' },
  { code: 'ko', label: '한국어', dir: 'ko' },
  { code: 'de', label: 'Deutsch', dir: 'de' },
  { code: 'es', label: 'Español', dir: 'es' },
  { code: 'fr', label: 'Français', dir: 'fr' },
  { code: 'ru', label: 'Русский', dir: 'ru' },
]

/** Where a language's README lives, relative to the repo root. */
export const readmeOf = (lang) => (lang.dir === '' ? 'README.md' : `docs/readme/README_${lang.code}.md`)

/** Look up a language by its code; throws rather than returning undefined. */
export const languageOf = (code) => {
  const found = LANGUAGES.find((l) => l.code === code)
  if (!found) throw new Error(`unknown language code: ${code}`)
  return found
}
