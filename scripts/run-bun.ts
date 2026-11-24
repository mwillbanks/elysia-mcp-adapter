export async function runBun(
  arguments_: string[],
  cwd: string,
  executable = process.execPath,
  timeoutMs = 180_000
): Promise<string> {
  const child = Bun.spawn([executable, ...arguments_], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HUSKY: '0' }
  })
  const timeout = setTimeout(() => child.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(timeout))
  if (code !== 0) {
    throw new Error(
      `${executable} ${arguments_.join(' ')} failed (${code}) in ${cwd}\n${stdout.trim()}\n${stderr.trim()}`
    )
  }
  return stdout.trim()
}
