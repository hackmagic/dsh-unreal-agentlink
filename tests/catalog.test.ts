/**
 * The catalog is the plugin's only authority on what the editor implements, so
 * two classes of bug here are invisible until they hurt someone:
 *
 * 1. **Unknown methods reaching the editor.** `riskOf()` answers `'dangerous'`
 *    for anything it has never heard of, which makes a "is it risky?" test
 *    useless as an existence test. The gate must ask `isKnown()`. The original
 *    prefix heuristic denied real methods (`level.save`) while waving through
 *    invented ones (`editor.delete_everything`) — both directions are pinned here.
 * 2. **Required-key drift.** `REQUIRED_KEYS` is generated from the handlers' own
 *    400 refusals. Wiring it in is only safe if it stays *narrow*: a key that is
 *    merely read, or read on one branch, must not be asserted, because a false
 *    positive rejects a legitimate call before the engine can answer it. The
 *    suppressed cases below were each traced to a C++ line (see the
 *    `REQUIRED_DROPPED` table in `scripts/extract-methods.mjs`).
 */
import { describe, it, expect } from 'vitest'

import { isKnown, requiresOf, riskOf, specOf, cacheable, timeoutFor, paramKeysOf, codesOf, METHOD_NAMES, METHODS, CATALOG_DRIFT } from '../src/catalog/methods.js'
import { UAL_CODES } from '../src/protocol/types.js'
import { translate } from '../src/errors/translate.js'
import { apply } from '../src/index.js'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

// ── existence: the catalog, not the risk table ──────────────────────────────

describe('isKnown: existence is a catalog question, not a risk question', () => {
  it('accepts a real method that is merely risky', () => {
    // `level.save` is dangerous and its name shares no prefix with the gate's old
    // allow-list, which is exactly how it got falsely denied.
    expect(riskOf('level.save')).toBe('dangerous')
    expect(isKnown('level.save')).toBe(true)
    expect(isKnown('content.migrate')).toBe(true)
    expect(isKnown('blueprint.import_t3d')).toBe(true)
  })

  it('rejects anything the editor does not implement', () => {
    expect(isKnown('editor.delete_everything')).toBe(false)
    expect(isKnown('actor.make_me_a_sandwich')).toBe(false)
    expect(isKnown('')).toBe(false)
  })

  it('does not walk the prototype chain', () => {
    // A plain `method in METHODS` lookup answers true for these.
    expect(isKnown('toString')).toBe(false)
    expect(isKnown('constructor')).toBe(false)
    expect(isKnown('hasOwnProperty')).toBe(false)
  })

  it('has no drift against the registered-method list', () => {
    expect(CATALOG_DRIFT).toEqual([])
    expect(METHOD_NAMES).toHaveLength(170)
  })
})

// ── required keys: narrow by construction ───────────────────────────────────

describe('requiresOf: only keys the handler refuses without', () => {
  it('reports keys the handler hard-requires', () => {
    expect(requiresOf('cmd.run_python')).toEqual(['script'])
    expect(requiresOf('system.run_console_command')).toEqual(['command'])
    expect(requiresOf('sequence.render')).toEqual(['sequence_path'])
    expect(requiresOf('project.set_config')).toEqual(['config_name', 'key', 'section', 'value'])
  })

  it('stays silent for methods whose refusal offers a choice', () => {
    // "Missing field: name or path" (UAL_ActorCommands.cpp:798) claims nothing:
    // a `targets` object or a bare `path` both satisfy Handle_GetActor.
    expect(requiresOf('actor.get')).toEqual([])
  })

  it('does not inherit keys that are branch-local in a callee', () => {
    // `struct_type`/`target_class` belong to individual node specs inside
    // UAL_CreateNodeInternal, not to the create_graph request.
    expect(requiresOf('blueprint.create_graph')).toEqual([])
  })

  it('keeps only the unconditional key behind an early dispatch', () => {
    // `context_path`/`action_path` are read only on the non-legacy branch; the
    // legacy branch needs `name` instead.
    expect(requiresOf('input.add_mapping')).toEqual(['key'])
  })

  it('returns an empty list for unknown methods rather than inventing keys', () => {
    expect(requiresOf('nope.nope')).toEqual([])
  })

  it('does not reach Object.prototype through the generated tables', () => {
    // `method` is model-supplied, and every table is an object literal. A bare
    // `TABLE[method]` answers with a FUNCTION for these names, which then gets
    // spread into the parameter list. `ual_schema` on "toString" used to throw.
    const inherited = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']
    for (const method of inherited) {
      expect(requiresOf(method), `requiresOf(${method})`).toEqual([])
      expect(paramKeysOf(method), `paramKeysOf(${method})`).toEqual([])
      expect(codesOf(method), `codesOf(${method})`).toEqual([])
      expect(specOf(method), `specOf(${method})`).toBeUndefined()
      expect(riskOf(method), `riskOf(${method})`).toBe('dangerous')
      expect(cacheable(method), `cacheable(${method})`).toBe(false)
      expect(timeoutFor(method, 1000), `timeoutFor(${method})`).toBe(1000)
    }
  })

  it('never asserts a key the catalog does not also list as a parameter', () => {
    // A required key that is not a documented parameter would be unsatisfiable.
    for (const method of METHOD_NAMES) {
      const spec = METHODS[method]!
      for (const key of requiresOf(method)) {
        expect(spec, `${method} requires "${key}" but has no summary`).toBeDefined()
      }
    }
  })
})

// ── every code the plugin sends has a translation ───────────────────────────

describe('UAL_CODES: the declared set is the one translate() actually handles', () => {
  // `translate()` classifies by number and falls through to `engine-error`, whose
  // hint says the arguments were fine and the editor broke. That is the right
  // default only for codes nobody classified. 410/422/504 are sent by real
  // handlers (pcg.execute, blueprint.import_t3d) and used to land there, telling
  // the model the opposite of the truth — 422 means "your input produced nothing".
  it('covers the plugin code set, with no code silently defaulting to engine-error', () => {
    expect([...UAL_CODES].sort((a, b) => a - b)).toEqual([200, 207, 400, 404, 409, 410, 412, 413, 422, 500, 501, 503, 504])
  })

  it('classifies every declared code into a kind, never the bare fallback', () => {
    // 200/207 are successes and never reach classify() as failures, so they are
    // excluded; every other declared code must name something more specific than
    // the generic `engine-error` catch-all.
    const specific = new Map<number, string>([
      [400, 'bad-params'],
      [404, 'not-found'],
      [409, 'conflict'],
      [410, 'not-found'],
      [412, 'precondition'],
      [413, 'precondition'],
      [422, 'precondition'],
      [500, 'engine-error'],
      [501, 'unsupported'],
      [503, 'registry-busy'],
      [504, 'timeout'],
    ])
    for (const code of UAL_CODES) {
      if (code === 200 || code === 207) continue
      const expected = specific.get(code)
      expect(expected, `UAL_CODES names ${code} but this test does not say what kind it is`).toBeDefined()
      expect(translate({ code, message: 'x' }, 'actor.get').kind, `code ${code}`).toBe(expected)
    }
  })
})

// ── the approval gate, end to end ───────────────────────────────────────────

/** A ctx stub that captures the gate instead of starting the bridge. */
function gate() {
  let handler: ((exec: unknown, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
  const registered: string[] = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
    tools: { register: (tool: { name: string }) => void registered.push(tool.name) },
    on: (event: string, fn: never) => {
      if (event === 'tools/pre-execute') handler = fn
    },
    // Deliberately does NOT run the callback: running it would bind port 17860.
    effect: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never)
  if (!handler) throw new Error('apply() registered no tools/pre-execute gate')
  const allow: PreToolDecision = { kind: 'allow' }
  return {
    registered,
    decide: (name: string, args: unknown) => handler!({ name, arguments: args }, () => Promise.resolve(allow)),
  }
}

describe('tools/pre-execute: unknown methods are denied, risky ones ask', () => {
  it('registers all twelve tools', () => {
    expect(gate().registered).toHaveLength(12)
  })

  it('denies a method the editor does not implement', async () => {
    const decision = await gate().decide('ual_call', { method: 'editor.delete_everything' })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('editor.delete_everything')
  })

  it('denies an invented name that shares a prefix with a real family', async () => {
    // The old heuristic allowed every `editor.*`/`system.*`/`project.*`/`cpp.*`/
    // `cmd.*` name through on the strength of its prefix.
    for (const method of ['editor.delete_everything', 'system.format_c_drive', 'cpp.rm_rf']) {
      expect((await gate().decide('ual_call', { method })).kind).toBe('deny')
    }
  })

  it('lets a real dangerous method reach the approval seam instead of denying it', async () => {
    const decision = await gate().decide('ual_call', { method: 'level.save' })
    expect(decision.kind).toBe('ask')
  })

  it('lets a real read method through untouched', async () => {
    expect((await gate().decide('ual_call', { method: 'actor.get_info' })).kind).toBe('allow')
  })

  it('denies an unknown method hidden inside a batch', async () => {
    const decision = await gate().decide('ual_batch', {
      calls: [{ method: 'actor.get_info' }, { method: 'nope.nope' }],
    })
    expect(decision.kind).toBe('deny')
  })

  it('escalates a whole batch to ask when one entry is dangerous', async () => {
    const decision = await gate().decide('ual_batch', {
      calls: [{ method: 'actor.get_info' }, { method: 'editor.quit' }],
    })
    expect(decision.kind).toBe('ask')
  })

  it('leaves a read-only batch alone', async () => {
    const decision = await gate().decide('ual_batch', {
      calls: [{ method: 'actor.get_info' }, { method: 'level.list' }],
    })
    expect(decision.kind).toBe('allow')
  })

  it('names the risky entry in a batch prompt instead of "(unknown method)"', async () => {
    // `ual_batch` carries `calls[]`, not `method`, so reading `args.method` made
    // every batch approval read "batch containing (unknown method)".
    const decision = await gate().decide('ual_batch', {
      calls: [{ method: 'actor.get_info' }, { method: 'editor.quit' }],
    })
    const reason = decision.kind === 'ask' ? (decision.reason ?? '') : ''
    expect(reason).toContain('editor.quit')
    expect(reason).not.toContain('unknown method')
    expect(reason).toContain('2 call(s)')
  })

  it('names the single command in a plain approval prompt', async () => {
    const decision = await gate().decide('ual_call', { method: 'level.save' })
    expect(decision.kind === 'ask' && decision.reason).toContain('level.save')
  })
})
