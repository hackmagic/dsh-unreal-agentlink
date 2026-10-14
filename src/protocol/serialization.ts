/**
 * The single conversion between JS values and what UAL's `FJsonSerializer` can
 * actually read back.
 *
 * ## Why this is load-bearing, not a nicety
 *
 * UE deserializes into `TSharedPtr<FJsonValue>`, and command handlers read it
 * with `TryGetStringField` / `TryGetNumberField` / `TryGetBoolField` /
 * `TryGetObjectField` / `TryGetArrayField`. Those accessors **fail closed and
 * silent**: `TryGetBoolField` on a JSON string returns false with no error, a
 * `NaN` arrives as `null` and reads as "field absent", a wrong-typed value
 * becomes the handler's default. Upstream's own note about old plugins is that
 * they "silently ignore unknown params" — the same silence applies to
 * wrong-typed ones.
 *
 * So a caller handing us `{"intensity": "1000"}` where a number belongs, or a
 * `1e999`, would get a **successful-looking no-op** instead of an error. For an
 * agent that is the worst failure mode there is: it will read the `ok` and move
 * on. This module refuses those values before anything reaches the wire.
 *
 * Rules, in order:
 * 1. `undefined` / function / symbol / bigint → rejected (not JSON).
 * 2. `NaN` / `±Infinity` → rejected (UE reads them as a missing field).
 * 3. Circular references → rejected (`JSON.stringify` would throw mid-frame).
 * 4. `Uint8Array` → base64 (nothing in UAL needs it yet; the alternative is a
 *    silent `null`).
 * 5. `Date` → ISO string. `Map`/`Set` → object/array.
 * 6. Plain objects and arrays recurse; `undefined` entries are dropped rather
 *    than sent, since omitting a key is not the same as sending `null`.
 *
 * @module protocol/serialization
 */

export type Serializable =
  | null
  | boolean
  | number
  | string
  | readonly Serializable[]
  | { readonly [key: string]: Serializable }

export class SerializationError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'SerializationError'
    this.path = path
  }
}

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function walk(value: unknown, path: string, seen: Set<object>): Serializable {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value as string | boolean
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new SerializationError(path, `${String(value)} is not representable in JSON — UE would read the field as absent`)
    }
    return value as number
  }
  if (type === 'undefined') throw new SerializationError(path, 'undefined is not JSON; omit the key instead')
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new SerializationError(path, `${type} is not JSON`)
  }

  const object = value as object
  if (seen.has(object)) throw new SerializationError(path, 'circular reference')

  if (object instanceof Uint8Array) return Buffer.from(object).toString('base64')

  if (Array.isArray(object)) {
    seen.add(object)
    const out: Serializable[] = []
    for (let index = 0; index < object.length; index += 1) {
      out.push(walk(object[index], `${path}[${index}]`, seen))
    }
    seen.delete(object)
    return out
  }

  if (object instanceof Date) return object.toISOString()

  if (object instanceof Map) {
    seen.add(object)
    const out: Record<string, Serializable> = {}
    for (const [key, entry] of object) {
      if (typeof key !== 'string') throw new SerializationError(path, 'Map keys must be strings')
      out[key] = walk(entry, `${path}.${key}`, seen)
    }
    seen.delete(object)
    return out
  }

  if (object instanceof Set) {
    seen.add(object)
    const out: Serializable[] = []
    for (const entry of object) out.push(walk(entry, `${path}[]`, seen))
    seen.delete(object)
    return out
  }

  if (!isPlainObject(object)) {
    throw new SerializationError(path, 'only plain objects, arrays, and JSON scalars are accepted')
  }

  seen.add(object)
  const out: Record<string, Serializable> = {}
  for (const [key, entry] of Object.entries(object)) {
    if (entry === undefined) continue
    out[key] = walk(entry, path === '$' ? key : `${path}.${key}`, seen)
  }
  seen.delete(object)
  return out
}

/** Coerce `value` into a guaranteed-JSON shape, or throw {@link SerializationError}. */
export function toSerializable(value: unknown, label = '$'): Serializable {
  return walk(value, label, new Set())
}

/**
 * Deterministic key for a params object, used by the TTL cache and the breaker.
 * Key order is normalized; array order is preserved (for UAL, `filter.names`
 * order is meaningless but a `region` or curve-key array order is not — treating
 * order as significant is the safe direction).
 */
export function stableKey(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null) return 'null'
    if (typeof input === 'string') return JSON.stringify(input)
    if (typeof input === 'number' || typeof input === 'boolean') return String(input)
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`
    if (typeof input === 'object') {
      const record = input as Record<string, unknown>
      return `{${Object.keys(record)
        .sort()
        .map(key => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(',')}}`
    }
    return String(input)
  }
  return encode(value ?? null)
}
