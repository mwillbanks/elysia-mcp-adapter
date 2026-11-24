async function readOutput(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let output = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return output + decoder.decode()
      output += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

function terminateProcess(
  child: Pick<Bun.Subprocess, 'pid' | 'kill'>,
  processGroup: boolean
): void {
  if (!processGroup) return child.kill('SIGKILL')
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

export async function runBun(
  arguments_: string[],
  cwd: string,
  executable = process.execPath,
  timeoutMs = 180_000
): Promise<string> {
  const processGroup = process.platform !== 'win32'
  const child = Bun.spawn([executable, ...arguments_], {
    cwd,
    detached: processGroup,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HUSKY: '0' }
  })
  const stdoutReader = child.stdout.getReader()
  const stderrReader = child.stderr.getReader()
  const output = Promise.all([readOutput(stdoutReader), readOutput(stderrReader), child.exited])
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout>
  const cleanupFailure = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true
      try {
        terminateProcess(child, processGroup)
        // Windows cannot terminate a process group; descendants may retain these pipes.
        if (!processGroup) {
          void Promise.allSettled([stdoutReader.cancel(), stderrReader.cancel()])
        }
      } catch (error) {
        let cause = error
        try {
          child.kill('SIGKILL')
        } catch (cleanupError) {
          cause = new AggregateError([error, cleanupError], 'Process cleanup failed')
        }
        child.unref()
        // Descendants can retain these pipes when group termination fails.
        void Promise.allSettled([stdoutReader.cancel(), stderrReader.cancel()])
        reject(new Error(`Failed to terminate timed-out command in ${cwd}`, { cause }))
      }
    }, timeoutMs)
  })
  const [stdout, stderr, code] = await Promise.race([output, cleanupFailure]).finally(() =>
    clearTimeout(timeout)
  )
  if (timedOut || code !== 0) {
    throw new Error(
      `${executable} ${arguments_.join(' ')} ${timedOut ? `timed out after ${timeoutMs}ms` : `failed (${code})`} in ${cwd}\n${stdout.trim()}\n${stderr.trim()}`
    )
  }
  return stdout.trim()
}
