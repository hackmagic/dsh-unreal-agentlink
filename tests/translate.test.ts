/**
 * Error translation, which is the README's "LLM-friendly errors" promise.
 *
 * The load-bearing rule: **the plugin's message text is never parsed for control
 * flow.** It is produced by `UAL_CommandUtils::LStr(Zh, En)` keyed on the editor's
 * culture, so the same 404 arrives in Chinese on a Chinese editor. Every test here
 * uses a locale-bearing message and asserts that classification came from the code
 * or the class name instead.
 */
import { describe, it, expect } from 'vitest'

import { translate, renderError } from '../src/errors/translate.js'

/** A transport-ish error shaped like the bridge's own classes, by name only. */
const named = (name: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { name, ...extra })

describe('translate: classification never reads the message text', () => {
  it('classifies by error NAME, so a Chinese or English message makes no difference', () => {
    const english = translate(named('NoEditorError', 'no editor is connected'), 'actor.list')
    const chinese = translate(named('NoEditorError', '没有编辑器连接'), 'actor.list')
    expect(english.kind).toBe('no-editor')
    expect(chinese.kind).toBe('no-editor')
  })

  it('maps each bridge class to its own kind', () => {
    const cases: Array<[string, string]> = [
      ['NoEditorError', 'no-editor'],
      ['BridgeTimeoutError', 'timeout'],
      ['EditorLostError', 'editor-lost'],
      ['CircuitOpenError', 'circuit-open'],
      ['RateLimitedError', 'rate-limited'],
      ['QueueStalledError', 'queue-stalled'],
      ['SerializationError', 'serialization'],
      ['AbortError', 'cancelled'],
    ]
    for (const [name, kind] of cases) {
      expect(translate(named(name, 'x'), 'actor.list').kind).toBe(kind)
    }
  })

  it('maps each wire code to its own kind', () => {
    const cases: Array<[number, string]> = [
      [400, 'bad-params'],
      [404, 'not-found'],
      [409, 'conflict'],
      [412, 'precondition'],
      [413, 'precondition'],
      [501, 'unsupported'],
      [503, 'registry-busy'],
      [500, 'engine-error'],
    ]
    for (const [code, kind] of cases) {
      expect(translate({ code, message: 'any text' }, 'actor.list').kind).toBe(kind)
    }
  })

  it('treats an unknown failure as an engine error rather than guessing', () => {
    expect(translate(new Error('boom'), 'actor.list').kind).toBe('engine-error')
  })
})

describe('translate: 200-with-ok:false is not an error kind of its own', () => {
  it('classifies a 409 with blocked_by_agent_undo as a conflict, and names the undo escape', () => {
    const translated = translate({ code: 409, message: 'cannot delete', details: { blocked_by_agent_undo: true } }, 'content.delete')
    expect(translated.kind).toBe('conflict')
    expect(translated.hint).toContain('drop_agent_undo')
    expect(translated.retryable).toBe(false)
  })

  it('classifies a 409 with running as PIE already up', () => {
    const translated = translate({ code: 409, message: 'busy', details: { running: true } }, 'pie.play')
    expect(translated.hint).toContain('pie.stop')
  })
})

describe('translate: details are surfaced as facts, never swallowed', () => {
  it('keeps the plugin suggestions so a 400 becomes a one-token fix', () => {
    const translated = translate({ code: 400, message: 'unknown property', details: { suggestions: ['RelativeLocation', 'RelativeRotation'] } }, 'actor.set_property')
    expect(translated.facts).toEqual({ suggestions: ['RelativeLocation', 'RelativeRotation'] })
    expect(translated.hint).toContain('RelativeLocation, RelativeRotation')
  })

  it('reports expected_type/current_value instead of just "invalid"', () => {
    const translated = translate({ code: 400, message: 'bad type', details: { expected_type: 'number', current_value: '"3"' } }, 'actor.set_property')
    expect(translated.hint).toContain('Expected "number"')
    expect(translated.hint).toContain('but sent')
    expect(translated.facts).toBeDefined()
  })

  it('drops empty details rather than reporting a vacuous DETAILS block', () => {
    expect(translate({ code: 400, message: 'bad', details: {} }, 'actor.list').facts).toBeUndefined()
  })
})

describe('translate: retryability is honest, not optimistic', () => {
  it('says a timeout may still be running, and forbids resending', () => {
    const translated = translate(named('BridgeTimeoutError', 'no reply in 180000ms'), 'sequence.render')
    expect(translated.retryable).toBe(false)
    expect(translated.hint).toContain('Do NOT resend')
    expect(translated.hint).toContain('sequence.render')
  })

  it('says an editor loss is not retryable because the write may have landed', () => {
    const translated = translate(named('EditorLostError', 'socket closed'), 'content.delete')
    expect(translated.retryable).toBe(false)
    expect(translated.hint).toContain('may have landed')
  })

  it('says the open circuit is retryable only after the window, and says to stop sending', () => {
    const translated = translate(named('CircuitOpenError', 'open', { retryAfterMs: 20_000 }), 'actor.list')
    expect(translated.retryable).toBe(true)
    expect(translated.hint).toContain('Stop sending editor commands')
  })

  it('says a 503 registry scan is retryable and forbids the deadlocking wait mode', () => {
    const translated = translate({ code: 503, message: 'registry gathering', details: { progress: { total: 100, processed: 40 } } }, 'content.search')
    expect(translated.kind).toBe('registry-busy')
    expect(translated.retryable).toBe(true)
    expect(translated.hint).toContain('40/100')
    expect(translated.hint).toContain('deadlock')
  })

  it('treats a 503 without registry-shaped details as plain capacity', () => {
    const translated = translate({ code: 503, message: 'busy', details: { other: 1 } }, 'actor.list')
    expect(translated.retryable).toBe(true)
    expect(translated.hint).toContain('retry once')
  })
})

describe('translate: the 413 advice names the actual cap source', () => {
  it('points at ual.MaxBatchCreate and says to split, when the details carry the max', () => {
    const translated = translate({ code: 413, message: 'too many', details: { instances: 80, max: 50 } }, 'actor.spawn')
    expect(translated.kind).toBe('precondition')
    expect(translated.hint).toContain('ual.MaxBatchCreate')
    expect(translated.hint).toContain('chunks of 50')
  })
})

describe('translate: a 404 on a registered method is "not found", not "no such method"', () => {
  it('distinguishes a missing method from a missing object', () => {
    const missingObject = translate({ code: 404, message: 'not found' }, 'actor.get')
    expect(missingObject.kind).toBe('not-found')
    expect(missingObject.hint).toContain('was not found')

    const missingMethod = translate({ code: 404, message: 'not found' }, 'actor.totally_made_up')
    expect(missingMethod.hint).toContain('does not implement')
  })
})

describe('translate: codes the handlers really send are classified, not defaulted', () => {
  // 410 (object destroyed mid-flight), 422 (accepted but nothing written) and 504
  // (editor gave up on its own budget) all appear in the C++ but were falling
  // through to `engine-error`, whose hint asserts the opposite of the truth for
  // 422: it told the model the arguments were fine and the editor broke.
  it('treats a 410 like a 404: the name is stale, so do not resend', () => {
    const translated = translate({ code: 410, message: 'PCG volume was destroyed' }, 'pcg.generate')
    expect(translated.kind).toBe('not-found')
    expect(translated.hint).toContain('destroyed before the command finished')
    expect(translated.retryable).toBe(false)
  })

  it('calls a 422 a precondition problem and says nothing landed', () => {
    const translated = translate({ code: 422, message: 'imported 0 nodes' }, 'blueprint.import_t3d')
    expect(translated.kind).toBe('precondition')
    expect(translated.hint).toContain('rolled its transaction back')
    expect(translated.hint).not.toContain('failed inside the editor')
    expect(translated.retryable).toBe(false)
  })

  it('calls a 504 a timeout and does not claim the command is still running', () => {
    const translated = translate({ code: 504, message: 'previous result never cleared' }, 'pcg.generate')
    expect(translated.kind).toBe('timeout')
    expect(translated.hint).toContain('gave up waiting on its own timeout')
    expect(translated.hint).not.toContain('almost certainly still running')
    expect(translated.retryable).toBe(false)
  })

  it('still gives an ordinary socket timeout the "still running" advice', () => {
    const translated = translate(named('BridgeTimeoutError', 'timed out'), 'sequence.render')
    expect(translated.kind).toBe('timeout')
    expect(translated.hint).toContain('almost certainly still running')
  })
})

describe('renderError: one screen of text, structured for the model', () => {
  it('includes the kind, the ue code, the hint, and the details', () => {
    const text = renderError(translate({ code: 400, message: 'unknown property', details: { suggestions: ['X'] } }, 'actor.set_property')).text
    expect(text).toContain('ERROR [bad-params]')
    expect(text).toContain('ue_code=400')
    expect(text).toContain('HINT:')
    expect(text).toContain('DETAILS:')
  })

  it('marks retryable failures so the model knows to try again', () => {
    const text = renderError(translate(named('CircuitOpenError', 'open'), 'actor.list')).text
    expect(text).toContain('RETRY:')
  })
})
