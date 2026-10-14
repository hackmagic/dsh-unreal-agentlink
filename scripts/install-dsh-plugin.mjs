/*
 * One-time installer: registers this plugin with a dsh profile as a bundle.
 *
 * WHY THIS EXISTS
 * ---------------
 * DSH ships no command that installs a LOCAL, out-of-tree plugin into a profile.
 * The two shipped paths are:
 *   - `dsh plugin --profile <name> add <pkg>`  — pnpm in that profile's dir, and
 *     it is refused outright for the `desktop` profile (`bin.js:38`
 *     `rejectElectronProfile`), which only the Electron app may manage.
 *   - hand-editing `<profile>/package.json` (dependency entry) AND
 *     `dsh.profile.bundles` (patch-layer entry). Both are mandatory: a listed
 *     package that declares no `dsh.bundle` fails loud, and an installed package
 *     that is not listed contributes no layer at all.
 *
 * This script does the second thing safely: it edits the profile manifest
 * atomically (taking the same writer lock the product uses), mirrors the project
 * into the profile's `.vendor/` so `file:` never points at a live workspace, and
 * then defers to `dsh plugin --profile <name> install` so the real installer —
 * including `reconcileProfilePlugins` and the peer-dependency guard — runs and
 * validates the result.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never grants the version exemption itself. The guard is a product decision
 * ("Update the plugin or install a compatible version"); this project pins
 * 0.1.6-alpha.2 peer ranges while the shipped dsh is 0.2.0-rc.2, so the install
 * stops there on purpose and prints the exact command to accept the risk.
 *
 * Usage:
 *   node scripts/install-dsh-plugin.mjs --profile web            # install
 *   node scripts/install-dsh-plugin.mjs --profile web --status    # check
 *   node scripts/install-dsh-plugin.mjs --profile web --remove    # undo
 *
 *   --vendor-dir <dir>   mirror the project there instead of <profile>/.vendor
 *   --profile-dir <dir>  the profile directory itself, instead of
 *                        <DSH_HOME>/profiles/<profile>. Exists so a test can
 *                        target a scratch tree; an operator never needs it.
 *   --no-mirror          use the source directory itself as the file: target
 *   --dsh <path>         dsh launcher (default: auto-detect)
 *   --yes                skip the confirmation prompt
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '..')
const manifest = JSON.parse(readFileSync(path.join(PROJECT, 'package.json'), 'utf8'))
const NAME = manifest.name
const VERSION = manifest.version

const DSH_CANDIDATES = [
  'D:\\WorkSoftware\\deepseek\\resources\\runtime\\cli\\bin\\dsh.cmd',
  path.join(homedir(), '.dsh', 'bin', 'dsh.cmd')
]

function fail(message) {
  console.error(`install: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { profile: '', status: false, remove: false, mirror: true, yes: false, dsh: '', vendorDir: '', profileDir: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i] ?? ''
    else if (arg === '--status') out.status = true
    else if (arg === '--remove') out.remove = true
    else if (arg === '--no-mirror') out.mirror = false
    else if (arg === '--yes') out.yes = true
    else if (arg === '--dsh') out.dsh = argv[++i] ?? ''
    else if (arg === '--vendor-dir') out.vendorDir = argv[++i] ?? ''
    else if (arg === '--profile-dir') out.profileDir = argv[++i] ?? ''
    else fail(`unknown argument ${arg}`)
  }
  return out
}

function profilesRoot() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'profiles')
}

/**
 * Where a profile lives. `DSH_HOME` is honoured so a test (or an operator with a
 * second installation) can point the installer at a scratch tree instead of the
 * real one — the same variable the product itself reads.
 */
function profileDir(name) {
  return path.join(profilesRoot(), name)
}

function resolveDsh(explicit) {
  if (explicit) return explicit
  for (const candidate of DSH_CANDIDATES) if (existsSync(candidate)) return candidate
  fail('could not find the dsh launcher; pass --dsh <path to dsh.cmd>')
}

/**
 * dsh is shipped as `dsh.cmd`, and Node 22+ refuses to spawn a `.cmd` without
 * a shell (`EINVAL`) while `shell: true` concatenates arguments unescaped and
 * trips DEP0190. Measured on this host: `cmd /d /s /c` with a quoted path fails
 * ("is not recognized as an internal or external command") for every quoting
 * variant — quoting the path, quoting the whole line, or prefixing `call` — and
 * works ONLY when the path is left unquoted. So: unquoted path + quoted
 * arguments. The path is either a fixed default under Program Files or an
 * operator-supplied `--dsh` value; `--dsh` is quoted by the caller if needed.
 */
function run(bin, argv, options) {
  const line = [bin, ...argv.map((a) => (a.includes(' ') ? `"${a}"` : a))].join(' ')
  const result = spawnSync(
    process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : bin,
    process.platform === 'win32' ? ['/d', '/s', '/c', line] : argv,
    { ...options, windowsVerbatimArguments: false }
  )
  return result
}

/** Run the real installer so reconcileProfilePlugins and the peer guard still apply. */
function dsh(dshBin, profile, args) {
  const result = run(dshBin, ['plugin', '--profile', profile, ...args], { stdio: 'inherit' })
  return result.status ?? 1
}

function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer) })
  })
}

/**
 * Mirror only what `npm pack` ships, so `file:` never points at a live
 * workspace: a half-saved source file, a deleted `lib/`, or a stray
 * `.audit-tmp/` directory would otherwise become the plugin dsh loads.
 */
function mirror(project, target) {
  const spec = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'))
  const wanted = []
  for (const entry of spec.files ?? []) {
    const from = path.resolve(project, entry)
    if (existsSync(from)) wanted.push(from)
  }
  for (const keep of ['package.json', 'LICENSE', 'README.md']) {
    const from = path.join(project, keep)
    if (existsSync(from)) wanted.push(from)
  }
  rmSync(target, { recursive: true, force: true })
  for (const from of wanted) {
    const to = path.join(target, path.basename(from))
    cpSync(from, to, { recursive: true })
  }
  return wanted.length
}

/**
 * The dsh side writes `<profile>/package.json` through dsh-atomic-write: a
 * `wx`-created sibling `<file>.lock` holding the holder's PID, with
 * DEFAULT_LOCK_WAIT_MS = 2s and the comment "orphan recovery is an operator
 * action" — a contender NEVER deletes an existing lock. A running Electron app
 * holds the desktop profile's lock, so editing that manifest while dsh-desktop
 * is up fails with `atomic-write: timed out waiting for the writer lock`.
 * This script therefore refuses to touch a locked manifest rather than
 * fighting the lock, and tells the operator which process holds it.
 */
function lockHolder(manifestPath) {
  const lockPath = `${manifestPath}.lock`
  if (!existsSync(lockPath)) return null
  let pid = ''
  try {
    pid = readFileSync(lockPath, 'utf8').trim()
  } catch {
    pid = ''
  }
  let who = ''
  if (/^\d+$/.test(pid) && pid !== String(process.pid)) {
    try {
      who = run('tasklist', ['/fi', `"PID eq ${pid}"`, '/nh', '/fo', 'csv'], { encoding: 'utf8' })
        .stdout?.split('\n')[0]?.split(',').pop()?.replace(/"/g, '') ?? ''
    } catch {
      who = ''
    }
  }
  return { pid, who: who || 'the DeepSeek Harness app' }
}

function readManifest(manifestPath) {
  const raw = readFileSync(manifestPath, 'utf8')
  // Preserve the two-space indent the product writes, and the key order the
  // user already has, so a diff of the profile stays one line long.
  const json = JSON.parse(raw)
  return { raw, json }
}

function writeManifest(manifestPath, json) {
  const raw = readFileSync(manifestPath, 'utf8')
  // Match the indent the profile already uses (the product writes two spaces)
  // so a diff of the profile manifest stays one line long.
  const indent = raw.includes('\n  "dependencies"') ? 2 : 2
  const text = `${JSON.stringify(json, null, indent)}\n`
  writeFileSync(manifestPath, text, 'utf8')
}

function bundlesOf(json) {
  return json.dsh?.profile?.bundles ?? []
}

function withBundle(json, name) {
  const bundles = bundlesOf(json)
  if (bundles.includes(name)) return false
  bundles.push(name)
  if (!json.dsh) json.dsh = {}
  if (!json.dsh.profile) json.dsh.profile = {}
  json.dsh.profile.bundles = bundles
  return true
}

function withoutBundle(json, name) {
  const bundles = bundlesOf(json)
  const next = bundles.filter((entry) => entry !== name)
  if (next.length === bundles.length) return false
  if (!json.dsh?.profile) return false
  json.dsh.profile.bundles = next
  return true
}

function withDependency(json, name, spec) {
  if (!json.dependencies) json.dependencies = {}
  if (Object.hasOwn(json.dependencies, name)) return false
  json.dependencies[name] = spec
  return true
}

function withoutDependency(json, name) {
  if (!Object.hasOwn(json.dependencies ?? {}, name)) return false
  delete json.dependencies[name]
  return true
}

async function status(profileDir) {
  const manifestPath = path.join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    console.log(`profile ${path.basename(profileDir)}: not initialized (run any dsh command with --profile to create it)`)
    return
  }
  const { json } = readManifest(manifestPath)
  const dependency = json.dependencies?.[NAME]
  const bundle = bundlesOf(json).includes(NAME)
  const installed = existsSync(path.join(profileDir, 'node_modules', NAME, 'package.json'))
  const exempt = readExemption(profileDir, NAME, VERSION)
  console.log(`profile ${path.basename(profileDir)}`)
  console.log(`  dependency:      ${dependency ?? '(absent)'}`)
  console.log(`  bundle layer:    ${bundle ? 'listed' : '(not listed)'}`)
  console.log(`  installed copy:  ${installed ? 'present' : '(absent)'}`)
  console.log(`  version guard:   ${exempt ? `exempt for dsh ${exempt}` : 'not exempt'}`)
  if (!bundle || !installed) {
    console.log(`  next: node scripts/install-dsh-plugin.mjs --profile ${path.basename(profileDir)}`)
  }
}

function readExemption(profileDir, name, version) {
  const file = path.join(profileDir, 'compatibility.json')
  if (!existsSync(file)) return null
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    const list = json[`${name}@${version}`]
    return Array.isArray(list) && list.length ? list.join(', ') : null
  } catch {
    return null
  }
}

/**
 * Refuse to edit a manifest another process holds. Extracted because both the
 * install and the remove path write the same file, and forgetting this check in
 * one of them is exactly the kind of asymmetry that only shows up in the field.
 */
function refuseIfLocked(manifestPath) {
  const holder = lockHolder(manifestPath)
  if (!holder) return
  console.error(`install: ${manifestPath}.lock is held by pid ${holder.pid} (${holder.who})`)
  console.error('install: a running dsh holds its profile manifest. Close that app and retry,')
  console.error('install: or use --profile web while the desktop app is open.')
  process.exit(1)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.profile) fail('--profile <name> is required (e.g. web)')
  if (args.profile.toLowerCase() === 'desktop' && !args.remove) {
    console.error('install: the desktop profile is managed exclusively by the Electron application')
    console.error('install: (dsh bin.js:38 rejectElectronProfile). Close the app, or install into')
    console.error('install: the web profile instead, then copy the result by hand.')
    process.exit(1)
  }
  const dshBin = resolveDsh(args.dsh)
  const profileDir = args.profileDir ? path.resolve(args.profileDir) : path.join(profilesRoot(), args.profile)
  const manifestPath = path.join(profileDir, 'package.json')

  if (args.status) {
    await status(profileDir)
    return
  }

  if (args.remove) {
    if (!existsSync(manifestPath)) fail(`profile ${args.profile} has no package.json`)
    refuseIfLocked(manifestPath)
    const { json } = readManifest(manifestPath)
    const a = withoutDependency(json, NAME)
    const b = withoutBundle(json, NAME)
    if (a || b) writeManifest(manifestPath, json)
    console.log(`removed ${NAME} from ${args.profile} (dependency ${a ? 'dropped' : 'absent'}, bundle ${b ? 'dropped' : 'absent'})`)
    const code = dsh(dshBin, args.profile, ['install'])
    process.exit(code)
  }

  if (!existsSync(manifestPath)) fail(`profile ${args.profile} has no package.json — run \`dsh ${args.profile}\` once to create it`)
  refuseIfLocked(manifestPath)

  const target = args.mirror
    ? (args.vendorDir ? path.resolve(args.vendorDir) : path.join(profileDir, '.vendor'))
    : PROJECT
  const spec = `file:${target.replace(/\\/g, '/')}`

  if (args.mirror) {
    const copied = mirror(PROJECT, target)
    console.log(`mirrored ${copied} entries into ${target}`)
  } else {
    console.log(`using the workspace itself as the file: target (no mirror)`)
  }

  if (!args.yes) {
    const answer = await confirm(`install ${NAME}@${VERSION} into profile "${args.profile}" via ${spec}? [y/N] `)
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('install: aborted; no changes were written')
      process.exit(1)
    }
  }

  const { json } = readManifest(manifestPath)
  const changedDependency = withDependency(json, NAME, spec)
  const changedBundle = withBundle(json, NAME)
  if (!changedDependency && !changedBundle) {
    console.log(`install: ${NAME} is already registered in ${args.profile}`)
  } else {
    writeManifest(manifestPath, json)
    console.log(`install: wrote ${path.relative(PROJECT, manifestPath)} (dependency ${changedDependency ? 'added' : 'present'}, bundle ${changedBundle ? 'added' : 'present'})`)
  }

  // The real installer does the peer-dependency check, the reconcile of
  // dsh.profile.bundles, and the actual pnpm run.
  const exempt = readExemption(profileDir, NAME, VERSION)
  if (!exempt) {
    console.log(`install: note: ${NAME}@${VERSION} pins @deepseek-ai peer ranges that this dsh`)
    console.log(`install: runtime does not ship, so the guard will stop the install. To accept that`)
    console.log(`install: risk explicitly (a product decision, not this script's to make):`)
    console.log(`install:   ${path.basename(dshBin)} plugin --profile ${args.profile} allow-version ${NAME}@${VERSION} --dsh-version <dsh version> --accept-risk`)
  }

  const code = dsh(dshBin, args.profile, ['install'])
  if (code !== 0) {
    console.error(`install: dsh rejected the install; diagnostics under ${path.join(profileDir, '.plugin-manager', 'logs')}`)
    if (!exempt) {
      console.error(`install: the version guard is still not exempt for ${NAME}@${VERSION}. Grant it with:`)
      console.error(`install:   ${path.basename(dshBin)} plugin --profile ${args.profile} allow-version ${NAME}@${VERSION} --dsh-version <dsh version> --accept-risk`)
    }
    process.exit(code)
  }

  // A bundle that is listed but declares no `dsh.bundle` fails loud at boot, so
  // the last check is the one that actually proves the layer is composed.
  const dumped = run(dshBin, ['--profile', args.profile, '--dump-config'], { encoding: 'utf8' })
  const composed = dumped.stdout ?? ''
  if (!composed.includes(`# == ${NAME}`)) {
    console.error(`install: installed, but the composed tree does not contain "# == ${NAME}"`)
    console.error(dumped.stderr?.trim() || '')
    process.exit(1)
  }
  console.log(`install: ${NAME} is now a bundle layer of profile "${args.profile}"`)
}

main().catch((error) => fail(error?.message ?? String(error)))


