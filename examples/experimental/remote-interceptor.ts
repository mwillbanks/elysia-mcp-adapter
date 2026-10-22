import { DEFAULT_PROTOCOL_VERSION } from '@mwillbanks/elysia-mcp-adapter'

/** Invoke a separate Streamable HTTP interceptor service, then stop the child process. */
export async function runRemoteInterceptorExample() {
  const service = import.meta.url.endsWith('.ts')
    ? './interceptor-service.ts'
    : './interceptor-service.js'
  const child = Bun.spawn([process.execPath, new URL(service, import.meta.url).pathname], {
    stdout: 'pipe',
    stderr: 'inherit'
  })
  const reader = child.stdout.getReader()
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const ready = await Promise.race([
      readReadyLine(reader),
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error('Interceptor service did not start')),
          10_000
        )
      })
    ])
    clearTimeout(startupTimer)
    const { url, pid } = JSON.parse(ready) as { url: string; pid: number }
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': DEFAULT_PROTOCOL_VERSION,
          'mcp-method': method
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': DEFAULT_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientInfo': {
                name: 'remote-interceptor-example',
                version: '1'
              },
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        }),
        signal: AbortSignal.timeout(5_000)
      })
      if (!response.ok) throw new Error(`Interceptor HTTP request failed: ${response.status}`)
      return (await response.json()) as { result?: any; error?: { code: number; message: string } }
    }
    const listed = await rpc('interceptors/list', {})
    const invocation = {
      name: 'prefix-name',
      event: 'tools/call',
      phase: 'request',
      payload: { name: ' example ' },
      context: {
        timestamp: '2026-10-22T12:00:00Z',
        traceId: 'example-trace',
        spanId: 'example-span',
        sessionId: 'caller-session'
      }
    }
    const configured = await rpc('interceptor/invoke', {
      ...invocation,
      config: { prefix: 'configured:' }
    })
    const defaults = await rpc('interceptor/invoke', invocation)
    const invalid = await rpc('interceptor/invoke', { ...invocation, config: { prefix: 42 } })
    return { pid, listed, configured, defaults, invalid }
  } finally {
    clearTimeout(startupTimer)
    child.kill()
    try {
      await reader.cancel()
    } finally {
      await child.exited
    }
  }
}

async function readReadyLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let line = ''
  while (!line.includes('\n')) {
    const next = await reader.read()
    if (next.done) throw new Error('Interceptor service exited before listening')
    line += decoder.decode(next.value, { stream: true })
    if (line.length > 4096) throw new Error('Interceptor service readiness message exceeded limit')
  }
  return line.slice(0, line.indexOf('\n'))
}
