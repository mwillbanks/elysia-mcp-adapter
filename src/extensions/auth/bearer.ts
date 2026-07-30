import type { BearerAuthorizationResult, McpBearerChallengeOptions } from './types.js'

// RFC 6750 section 2.1: b64token, with exactly one or more SP after Bearer.
const BEARER_AUTHORIZATION = /^Bearer +([A-Za-z0-9\-._~+/]+={0,})$/i

export function parseBearerAuthorization(
  authorization: string | null | undefined
): BearerAuthorizationResult {
  if (authorization === null || authorization === undefined) {
    return { ok: false, reason: 'missing' }
  }

  const match = BEARER_AUTHORIZATION.exec(authorization)
  if (!match?.[1]) {
    return { ok: false, reason: 'malformed' }
  }

  return { ok: true, token: match[1] }
}

function quoted(value: string): string {
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
    })
  ) {
    throw new TypeError('Bearer challenge values cannot contain control characters')
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Builds one RFC 6750 Bearer challenge. The parameter order is deterministic
 * to make responses and tests stable.
 */
export function buildBearerChallenge(options: McpBearerChallengeOptions): string {
  const resourceMetadata =
    options.resourceMetadata instanceof URL
      ? options.resourceMetadata.href
      : options.resourceMetadata
  const parameters = [`resource_metadata=${quoted(resourceMetadata)}`]

  if (options.error) {
    parameters.push(`error=${quoted(options.error)}`)
  }
  if (options.errorDescription !== undefined) {
    parameters.push(`error_description=${quoted(options.errorDescription)}`)
  }
  if (options.scope !== undefined) {
    const scope =
      typeof options.scope === 'string' ? options.scope : [...new Set(options.scope)].join(' ')
    parameters.push(`scope=${quoted(scope)}`)
  }

  return `Bearer ${parameters.join(', ')}`
}
