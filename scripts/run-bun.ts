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
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    if (processGroup) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    } else {
      child.kill('SIGKILL')
    }
  }, timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(timeout))
  if (timedOut || code !== 0) {
    throw new Error(
      `${executable} ${arguments_.join(' ')} ${timedOut ? `timed out after ${timeoutMs}ms` : `failed (${code})`} in ${cwd}\n${stdout.trim()}\n${stderr.trim()}`
    )
  }
  return stdout.trim()
}
