async function upstreamResponse(url: string, headers: HeadersInit): Promise<Response> {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`)
  return response
}

export async function readUpstreamText(url: string, headers: HeadersInit): Promise<string> {
  return (await upstreamResponse(url, headers)).text()
}

export async function readUpstreamBytes(url: string, headers: HeadersInit): Promise<ArrayBuffer> {
  return (await upstreamResponse(url, headers)).arrayBuffer()
}

export async function readUpstreamJson(
  url: string,
  headers: HeadersInit
): Promise<Record<string, unknown>> {
  const response = await upstreamResponse(url, headers)
  const value: unknown = await response.json()
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Upstream returned an invalid document')
  return value as Record<string, unknown>
}

export function upstreamString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Upstream omitted ${field}`)
  return value
}

export async function registryLatestVersion(name: string, headers: HeadersInit): Promise<string> {
  const supplied = new Headers(headers)
  const registryHeaders = new Headers({ accept: 'application/json' })
  const userAgent = supplied.get('user-agent')
  if (userAgent) registryHeaders.set('user-agent', userAgent)
  const metadata = await readUpstreamJson(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
    registryHeaders
  )
  return upstreamString(metadata.version, 'latest version')
}
