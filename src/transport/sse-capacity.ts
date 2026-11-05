/** Wait for a reader before producing another frame. One producer waits per stream. */
export function createSseCapacity() {
  let resume: (() => void) | undefined
  return {
    async wait(
      controller: ReadableStreamDefaultController<Uint8Array> | undefined,
      signal: AbortSignal
    ): Promise<void> {
      while (controller && !signal.aborted && (controller.desiredSize ?? 0) <= 0) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            resume = undefined
            signal.removeEventListener('abort', wake)
            resolve()
          }
          resume = wake
          signal.addEventListener('abort', wake, { once: true })
        })
      }
    },
    wake: () => resume?.()
  }
}
