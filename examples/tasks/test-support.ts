export interface RedisFixture {
  url: string
  close(): Promise<void>
}

interface RedisProcess {
  process: ReturnType<typeof Bun.spawn>
  cleanup(): Promise<void>
}

export async function startRedisFixture(): Promise<RedisFixture> {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} }
  })
  const port = listener.port
  listener.stop(true)

  const redisProcess = startRedisProcess(port)
  const { process } = redisProcess
  if (!(process.stdout instanceof ReadableStream) || !(process.stderr instanceof ReadableStream)) {
    await redisProcess.cleanup()
    throw new Error('Redis fixture did not expose piped output')
  }
  try {
    await waitForRedisReady(process, process.stdout, process.stderr, port)
  } catch (error) {
    await redisProcess.cleanup()
    throw error
  }
  return {
    url: `redis://127.0.0.1:${port}`,
    async close() {
      await redisProcess.cleanup()
    }
  }
}

function startRedisProcess(port: number): RedisProcess {
  const arguments_ = [
    '--bind',
    '127.0.0.1',
    '--port',
    String(port),
    '--save',
    '',
    '--appendonly',
    'no'
  ]
  const executable = Bun.which('redis-server')
  if (executable) return spawnRedis([executable, ...arguments_])

  const image = process.env.TASKS_TEST_REDIS_IMAGE
  const docker = Bun.which('docker')
  if (!image || !docker) {
    throw new Error('Tasks tests require redis-server or Docker with TASKS_TEST_REDIS_IMAGE set')
  }
  const containerName = `elysia-mcp-tasks-${crypto.randomUUID()}`
  const redis = spawnRedis([
    docker,
    'run',
    '--rm',
    '--name',
    containerName,
    '--pull',
    'never',
    '--network',
    'host',
    image,
    'redis-server',
    ...arguments_
  ])
  return {
    process: redis.process,
    async cleanup() {
      await redis.cleanup()
      const removal = Bun.spawn([docker, 'rm', '--force', containerName], {
        stdout: 'ignore',
        stderr: 'ignore'
      })
      await removal.exited
    }
  }
}

function spawnRedis(command: string[]): RedisProcess {
  const process = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  let cleaned = false
  return {
    process,
    async cleanup() {
      if (cleaned) return
      cleaned = true
      process.kill('SIGTERM')
      await process.exited
    }
  }
}

export async function waitFor<T>(
  description: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function waitForRedisReady(
  process: ReturnType<typeof Bun.spawn>,
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
  port: number
): Promise<void> {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  const timeout = setTimeout(() => process.kill('SIGTERM'), 10_000)
  let output = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += decoder.decode(chunk.value, { stream: true })
      if (output.includes('Ready to accept connections')) return
    }
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
  const error = await new Response(stderr).text()
  throw new Error(`Redis failed to listen on port ${port}: ${error.trim()}`)
}
