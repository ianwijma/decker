import type { Json } from '../shared/schema'
export type Scope = {
  inputs: Record<string, Json>
  vars: Record<string, Json>
  nodes: Record<string, Json>
  item?: Json
  index?: number
  error?: Json
}
function field(scope: Scope, path: string): Json {
  let value: unknown = scope
  for (const part of path.split('.')) {
    if (['__proto__', 'constructor', 'prototype'].includes(part))
      throw new Error('Unsafe field reference')
    if (value == null || typeof value !== 'object' || !Object.hasOwn(value, part))
      throw new Error(`Unavailable field: ${path}. Add an explicit fallback.`)
    value = (value as Record<string, unknown>)[part]
  }
  return value as Json
}
export function resolve(value: Json, scope: Scope): Json {
  if (typeof value === 'string') {
    const full = value.match(/^\{\{([\w.-]+)(?:\|([^}]*))?\}\}$/)
    const read = (path: string, fallback?: string) => {
      try {
        return field(scope, path)
      } catch (e) {
        if (fallback !== undefined) {
          try {
            return JSON.parse(fallback) as Json
          } catch {
            return fallback
          }
        }
        throw e
      }
    }
    if (full) return read(full[1], full[2])
    return value.replace(
      /\{\{([\w.-]+)(?:\|([^}]*))?\}\}/g,
      (_, path: string, fallback?: string) => {
        const v = read(path, fallback)
        return typeof v === 'string' ? v : JSON.stringify(v)
      }
    )
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, scope))
  if (value && typeof value === 'object') {
    if ('$transform' in value) {
      const input = resolve(value.value ?? null, scope)
      switch (value.$transform) {
        case 'length':
          return typeof input === 'string' || Array.isArray(input)
            ? input.length
            : Object.keys(input ?? {}).length
        case 'upper':
          return String(input).toUpperCase()
        case 'lower':
          return String(input).toLowerCase()
        case 'number': {
          const n = Number(input)
          if (!Number.isFinite(n)) throw new Error('Not a finite number')
          return n
        }
        case 'string':
          return typeof input === 'string' ? input : JSON.stringify(input)
        default:
          throw new Error('Unknown built-in transformation')
      }
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, scope)]))
  }
  return value
}
export function redact(value: unknown): Json {
  let budget = 12000
  const walk = (v: unknown, depth: number): Json => {
    if (budget <= 0 || depth > 8) return '[truncated]'
    if (typeof v === 'string') {
      const s = v
        .slice(0, Math.min(budget, 4096))
        .replace(/(Bearer\s+)[\w.\-/+=]+/gi, '$1[redacted]')
        .replace(/([?&](?:token|key|password|secret)=)[^&#\s]+/gi, '$1[redacted]')
      budget -= s.length
      return s
    }
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => walk(x, depth + 1))
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .slice(0, 100)
          .map(([k, val]) => [
            k,
            /password|secret|token|authorization|cookie|api.?key/i.test(k)
              ? '[redacted]'
              : walk(val, depth + 1)
          ])
      )
    return typeof v === 'number' || typeof v === 'boolean' || v === null ? v : String(v)
  }
  return walk(value, 0)
}
export function abortError(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('Cancelled')
}
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  abortError(signal)
  return new Promise<T>((resolve, reject) => {
    let cleanup: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      clearTimeout(cleanup)
      signal.removeEventListener('abort', cancel)
    }
    // Allow cooperative operations to clean up; never wait indefinitely for a service.
    const cancel = () => {
      cleanup = setTimeout(() => {
        finish()
        reject(signal.reason ?? new Error('Cancelled'))
      }, 750)
    }
    signal.addEventListener('abort', cancel, { once: true })
    operation.then(
      (value) => {
        finish()
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      (error) => {
        finish()
        reject(error)
      }
    )
    if (signal.aborted) cancel()
  })
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  abortError(signal)
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
    const timer = setTimeout(() => {
      done()
      resolve()
    }, ms)
    const cancel = () => {
      done()
      reject(signal.reason ?? new Error('Cancelled'))
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}
