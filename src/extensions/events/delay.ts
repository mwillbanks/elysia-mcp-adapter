export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const finish = (callback: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal?.reason))
    timer = setTimeout(() => finish(resolve), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
