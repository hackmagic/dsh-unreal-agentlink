/**
 * The wire contract.
 *
 * These tests exist because a silent protocol error is the most expensive bug in
 * this plugin: a wrong param key is accepted by UE's `TryGet*Field` accessors and
 * becomes a successful-looking no-op, and a wrong code reading turns a partial
 * failure into a reported success. So the envelope rules are pinned from the
 * plugin source, not from memory.
 */
import { describe, it, expect } from 'vitest'

import { UAL_VERSION, UAL_DEFAULT_PORT, type UalResponse } from '../src/protocol/types.js'
import { toSerializable, SerializationError } from '../src/protocol/serialization.js'
import { judge } from '../src/service.js'

describe('envelope constants', () => {
  it('writes the version the plugin documents but never validates', () => {
    expect(UAL_VERSION).toBe('1.0')
  })

  it('dials the port hardcoded in StartupModule()', () => {
    expect(UAL_DEFAULT_PORT).toBe(17860)
  })
})

describe('judge: the plugin answers 200 with a failed body', () => {
  it('treats a clean 200 as success', () => {
    expect(judge({ created: 1 }, 200)).toEqual({ ok: true, partial: false })
  })

  it('reads a 207 as partial, not as success', () => {
    expect(judge({ created: 1 }, 207)).toEqual({ ok: true, partial: true })
  })

  it('reads result.ok:false as a failure even on 200 (editor.undo)', () => {
    expect(judge({ ok: false, error: 'nothing to undo' }, 200)).toEqual({ ok: false, partial: false })
  })

  it('reads a non-empty result.error as a failure even on 200 (blueprint.compile)', () => {
    expect(judge({ ok: true, error: 'compile failed' }, 200)).toEqual({ ok: false, partial: false })
  })

  it('ignores an empty error string', () => {
    expect(judge({ error: '' }, 200)).toEqual({ ok: true, partial: false })
  })

  it('treats a missing body as success: the plugin omits result when it has none', () => {
    expect(judge(undefined, 200)).toEqual({ ok: true, partial: false })
  })

  it('treats an array body as an opaque success rather than hunting for ok', () => {
    expect(judge([1, 2, 3], 200)).toEqual({ ok: true, partial: false })
  })
})

describe('toSerializable: UE reads params with TryGet*Field, which fails closed', () => {
  it('rejects a non-finite number instead of letting UE read it as null/absent', () => {
    expect(() => toSerializable({ x: Number.NaN }, 'transform')).toThrow(SerializationError)
    expect(() => toSerializable({ x: Number.POSITIVE_INFINITY }, 'transform')).toThrow(SerializationError)
  })

  it('names the offending path so the agent can fix the call', () => {
    let message = ''
    try {
      toSerializable({ instances: [{ transform: { location: { x: Number.NaN } } }] }, 'params')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('instances[0].transform.location.x')
  })

  it('drops an undefined object entry rather than sending null (omitting is not the same as null)', () => {
    expect(toSerializable({ a: undefined, b: 1 }, 'params')).toEqual({ b: 1 })
  })

  it('rejects a top-level undefined outright', () => {
    expect(() => toSerializable(undefined, 'params')).toThrow(SerializationError)
  })

  it('rejects undefined inside an array, where there is no key to omit', () => {
    expect(() => toSerializable({ list: [1, undefined] }, 'params')).toThrow(SerializationError)
  })

  it('rejects bigint, which JSON.stringify cannot encode at all', () => {
    expect(() => toSerializable({ n: 1n }, 'params')).toThrow(/bigint/i)
  })

  it('rejects a circular reference', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    expect(() => toSerializable(circular, 'params')).toThrow(SerializationError)
  })

  it('encodes a Uint8Array as base64 so binary params survive the text frame', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    expect(toSerializable({ data: bytes }, 'params')).toEqual({ data: 'AAEC+v8=' })
  })

  it('converts a Date to ISO', () => {
    const at = new Date('2026-01-01T00:00:00.000Z')
    expect(toSerializable({ at }, 'params')).toEqual({ at: '2026-01-01T00:00:00.000Z' })
  })

  it('passes a nested plain object through untouched', () => {
    const value = { targets: { names: ['Cube'], filter: { class: 'StaticMeshActor' } } }
    expect(toSerializable(value, 'params')).toEqual(value)
  })

  it('round-trips: serializing twice is stable, so a cached call and a live one agree', () => {
    const once = toSerializable({ a: [1, { b: 'c' }] }, 'params')
    expect(toSerializable(once, 'params')).toEqual(once)
  })
})

describe('UalResponse: failure rides the same envelope', () => {
  it('signals failure by code alone, with no top-level error field', () => {
    const reply: UalResponse = { type: 'res', id: 'x', code: 404, result: { message: 'unknown method', details: {} } }
    expect(reply.code).toBe(404)
    expect('error' in reply).toBe(false)
  })

  it('omits result entirely when the handler had no data', () => {
    const reply: UalResponse = { type: 'res', id: 'x', code: 200 }
    expect(reply.result).toBeUndefined()
    expect(judge(reply.result, reply.code).ok).toBe(true)
  })
})
