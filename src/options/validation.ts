export const MAX_TIMER_DELAY_MS = 2_147_483_647

export function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value
}

export function assertPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${label} must be a positive integer`)
  }
}

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`)
  }
}

export function assertSigningKey(key: string | Uint8Array, label: string): void {
  const bytes = typeof key === 'string' ? new TextEncoder().encode(key) : key
  if (bytes.byteLength < 32) {
    throw new TypeError(`${label} signingKey must contain at least 32 bytes`)
  }
}

export function assertTimerDelay(value: number | undefined, label: string, maximum: number): void {
  if (value !== undefined && value > maximum) {
    throw new RangeError(`${label} must not exceed ${maximum} milliseconds`)
  }
}

export function resolveExperimentalRevision<T extends string>(
  label: string,
  value: 'current' | T | undefined,
  revision: T
): T {
  if (value === undefined || value === 'current' || value === revision) return revision
  throw new TypeError(`Unsupported ${label} revision: ${value}`)
}
