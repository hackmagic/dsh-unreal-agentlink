import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * The installer (`scripts/install-dsh-plugin.mjs`) is the only supported way to
 * register this plugin with a dsh profile, and it is the piece that touches
 * files outside this repository: a profile manifest under `$DSH_HOME/profiles`,
 * a mirror directory, and the dsh CLI itself. Every other script in `scripts/`
 * is pure — read this repo, write this repo — so nothing else in the test suite
 * would notice if the installer broke.
 *
 * What is tested here is therefore only what can be tested without a real dsh
 * installation and without touching the operator's real profiles:
 *
 *   - argument parsing rejects nonsense instead of guessing;
 *   - the `desktop` profile is refused, because the product itself refuses it
 *     (`bin.js:38 rejectElectronProfile`) and pretending otherwise would send an
 *     operator down a path that cannot work;
 *   - the manifest edit is exactly two lines — one dependency entry and one
 *     bundle entry — because a bundle needs BOTH: a listed package that declares
 *     no `dsh.bundle` fails loud at boot, and an installed package that is not
 *     listed contributes no layer at all;
 *   - the edit is idempotent, and it preserves every other key in the manifest;
 *   - the mirror contains only what `files` declares, so `file:` never points at
 *     a live workspace with a half-saved source file or a stray `.audit-tmp/`.
 *
 * Everything else in the installer — calling pnpm, the peer-dependency guard,
 * `--dump-config` verification — runs only against a real dsh, which is why the
 * script defers to `dsh plugin --profile <name> install` instead of
 * reimplementing it. Testing that here would mean testing dsh, not this plugin.
 *
 * A fake profile directory is used throughout: `--vendor-dir` and `--dsh` let the
 * script be pointed away from the operator's real `$DSH_HOME`, and `--no-mirror`
 * lets the mirror step be observed without copying 64 files.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'install-dsh-plugin.mjs')

  const run = (args: string[]) => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 0, stdout, stderr: '' }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
  }

  /** A profile directory as `initProfile` writes it, plus the bits this test needs. */
  const fakeProfile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ual-profile-'))
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-test',
          private: true,
          dependencies: { ws: '^8.18.0' },
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return dir
  }

  /**
   * A dsh stand-in. It always succeeds and — for the final `--dump-config`
   * verification — prints the layer marker the installer looks for, so the test
   * exercises the whole script instead of stopping at the manifest edit. A stub
   * that stayed silent would make every install report failure for a reason that
   * has nothing to do with this project.
   */
  const dshStub = (dir: string) => {
    const stub = join(dir, 'dsh-stub.cmd')
    writeFileSync(
      stub,
      '@echo off\r\n' +
        'echo # == dsh-unreal-agentlink\r\n' +
        'echo - id: unreal-agentlink\r\n' +
        'echo   name: dsh-unreal-agentlink\r\n' +
        'exit /b 0\r\n',
      'utf8',
    )
    return stub
  }

  /**
   * Common arguments: fake profile, stub dsh, scratch vendor dir, no prompt.
   * `--no-mirror` by default so a test that only asserts the manifest edit does
   * not copy 60+ files; the mirror test overrides it.
   */
  const against = (dir: string, extra: string[] = ['--no-mirror']) => [    '--profile',
    'test',
    '--yes',
    ...extra,
    '--profile-dir',
    dir,
    '--vendor-dir',
    join(dir, '.vendor'),
    '--dsh',
    dshStub(dir),
  ]

  describe('install-dsh-plugin argument handling', () => {
  it('refuses to run without a profile', () => {
    const r = run([])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('--profile')
  })

  it('refuses an unknown flag rather than ignoring it', () => {
    const r = run(['--profile', 'test', '--nonsense'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('unknown argument --nonsense')
  })

  it('refuses the desktop profile, which the product refuses too', () => {
    // `dsh plugin --profile desktop` is rejected by bin.js:38 — the Electron app
    // manages that profile exclusively. An installer that claimed otherwise would
    // write a manifest the operator cannot activate.
    const r = run(['--profile', 'desktop', '--yes'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('managed exclusively by the Electron application')
  })

  it('reports a profile that was never initialized instead of creating one', () => {
    const r = run(['--profile', 'no-such-profile-xyz', '--status'])
    expect(r.stdout).toContain('not initialized')
  })
})

describe('install-dsh-plugin manifest edit', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('adds exactly one dependency entry and one bundle entry', () => {
    const dir = fakeProfile()
    dirs.push(dir)
    const vendor = join(dir, '.vendor')

    // `--no-mirror` keeps the workspace itself as the `file:` target: the mirror
    // step copies 60+ files and is asserted separately, and here we only want the
    // two manifest lines.
    const r = run(against(dir))
    expect(r.status).toBe(0)

    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(Object.keys(after.dependencies)).toContain('dsh-unreal-agentlink')
    expect(after.dependencies['dsh-unreal-agentlink']).toBe(`file:${ROOT.replace(/\\/g, '/')}`)
    expect(after.dsh.profile.bundles).toContain('dsh-unreal-agentlink')
    // A bundle needs both registrations; only one of them is a no-op at boot.
    expect(after.dsh.profile.bundles).toHaveLength(2)
  })

  it('mirrors only what npm pack ships, never the live workspace', () => {
    const dir = fakeProfile()
    dirs.push(dir)
    const vendor = join(dir, '.vendor')

    // A stray file in the workspace must NOT end up in the mirror: `file:` copies
    // what it finds at install time, so whatever is in the mirror becomes the
    // plugin dsh loads. `.audit-tmp/` is the historical offender.
    mkdirSync(join(ROOT, '.audit-tmp'), { recursive: true })
    writeFileSync(join(ROOT, '.audit-tmp', 'probe.txt'), 'not part of the plugin', 'utf8')
    try {
      // Mirror ON (no --no-mirror): the vendor dir gets a copy, not a link.
      run(against(dir, []))
      expect(existsSync(join(vendor, '.audit-tmp'))).toBe(false)
      expect(existsSync(join(vendor, 'lib'))).toBe(true)
      expect(existsSync(join(vendor, 'cordis.patch.yml'))).toBe(true)
      // ...and the mirror, not the workspace, is what got written into the manifest.
      const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      expect(after.dependencies['dsh-unreal-agentlink']).toBe(`file:${vendor.replace(/\\/g, '/')}`)
    } finally {
      rmSync(join(ROOT, '.audit-tmp'), { recursive: true, force: true })
      rmSync(vendor, { recursive: true, force: true })
    }
  })

  it('preserves every other key in the manifest', () => {
    const dir = fakeProfile()
    dirs.push(dir)
    run(against(dir))

    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(after.name).toBe('dsh-profile-test')
    expect(after.private).toBe(true)
    expect(after.dependencies.ws).toBe('^8.18.0')
    expect(after.dsh.profile.bundles[0]).toBe('@deepseek-ai/dsh-base')
  })

  it('is idempotent — a second run changes nothing', () => {
    const dir = fakeProfile()
    dirs.push(dir)
    const args = against(dir)

    run(args)
    const first = readFileSync(join(dir, 'package.json'), 'utf8')
    const second = run(args)
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('already registered')

    const after = readFileSync(join(dir, 'package.json'), 'utf8')
    expect(after).toBe(first)
  })

  it('removes both entries on --remove and leaves the rest alone', () => {
    const dir = fakeProfile()
    dirs.push(dir)
    const args = against(dir)

    run(args)
    const removed = run([...args, '--remove'])
    expect(removed.status).toBe(0)
    expect(removed.stdout).toContain('dependency dropped')
    expect(removed.stdout).toContain('bundle dropped')

    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(after.dependencies).toEqual({ ws: '^8.18.0' })
    expect(after.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('refuses to touch a manifest whose lock is held', () => {
    // dsh-atomic-write creates a `wx` sibling lock holding the holder's PID, and a
    // contender never removes another holder's lock. A running dsh holds the lock
    // of the profile it is booting, so editing that manifest fails; the installer
    // must refuse and name the holder rather than fight the lock.
    const dir = fakeProfile()
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json.lock'), String(process.pid + 1), 'utf8')

    const r = run([...against(dir), '--remove'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('.lock is held by pid')
    // The lock file names a pid that is not ours, so the script must not mistake
    // the lock for its own — and must not have written anything.
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies).not.toHaveProperty(
      'dsh-unreal-agentlink',
    )
  })
})

describe('install-dsh-plugin status', () => {
  it('reports an unregistered profile as absent on every line', () => {
    const dir = fakeProfile()
    const r = run(['--profile', 'test', '--status', '--profile-dir', dir, '--vendor-dir', join(dir, '.vendor')])
    expect(r.stdout).toContain('dependency:      (absent)')
    expect(r.stdout).toContain('bundle layer:    (not listed)')
    expect(r.stdout).toContain('installed copy:  (absent)')
    expect(r.stdout).toContain('version guard:   not exempt')
    rmSync(dir, { recursive: true, force: true })
  })
})
