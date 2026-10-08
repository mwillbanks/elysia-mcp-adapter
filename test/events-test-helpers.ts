import { setSystemTime } from 'bun:test'

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export async function within<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function withControlledTime<T>(
  initialTime: Date,
  operation: (advance: (milliseconds: number) => void) => Promise<T>
): Promise<T> {
  let currentTime = initialTime.getTime()
  setSystemTime(currentTime)
  try {
    return await operation((milliseconds) => {
      currentTime += milliseconds
      setSystemTime(currentTime)
    })
  } finally {
    setSystemTime()
  }
}
