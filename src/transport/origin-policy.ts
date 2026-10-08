const SCHEME_WILDCARD = /^([a-z][a-z0-9+.-]*):\/\/\*$/u

export function assertAllowedOrigin(origin: string): void {
  if (origin === '*')
    throw new TypeError('transport.allowedOrigins does not allow a global wildcard')

  const wildcard = SCHEME_WILDCARD.exec(origin)
  if (wildcard) {
    const scheme = wildcard[1]
    if (scheme === 'http' || scheme === 'https') {
      throw new TypeError('HTTP and HTTPS origin wildcards are not allowed')
    }
    return
  }

  const scheme = serializedOriginScheme(origin)
  if (!scheme) {
    throw new TypeError(`Invalid serialized origin: ${origin}`)
  }
}

export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  const scheme = serializedOriginScheme(origin)
  if (!scheme) return false
  if (allowedOrigins.includes(origin)) return true
  return allowedOrigins.includes(`${scheme}://*`)
}

function serializedOriginScheme(origin: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return undefined
  }
  if (
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return undefined
  }

  const serialized = `${parsed.protocol}//${parsed.host}`
  if (origin !== serialized) return undefined
  return parsed.protocol.slice(0, -1)
}
