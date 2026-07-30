import { buildBearerChallenge, parseBearerAuthorization } from './bearer.js'
import { protectedResourceMetadataUrl } from './metadata.js'
import type {
  McpAccessTokenVerifier,
  McpAccessTokenVerifierFunction,
  McpAuthorizationResult,
  McpAuthPrincipal
} from './types.js'

function uniqueScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.flatMap((scope) => scope.split(/\s+/u)).filter(Boolean))]
}

export function filterAuthorizedScopes(
  requested: readonly string[],
  granted: readonly string[]
): string[] {
  const grantedSet = new Set(uniqueScopes(granted))
  return uniqueScopes(requested).filter((scope) => grantedSet.has(scope))
}

export function missingRequiredScopes(
  required: readonly string[],
  granted: readonly string[]
): string[] {
  const grantedSet = new Set(uniqueScopes(granted))
  return uniqueScopes(required).filter((scope) => !grantedSet.has(scope))
}

export function isAudienceAllowed(
  principal: Pick<McpAuthPrincipal, 'audience'>,
  resource: string
): boolean {
  const audience =
    typeof principal.audience === 'string' ? [principal.audience] : principal.audience
  return audience.includes(resource)
}

export function isPrincipalExpired(
  principal: Pick<McpAuthPrincipal, 'expiresAt'>,
  nowSeconds = Date.now() / 1000,
  clockSkewSeconds = 0
): boolean {
  assertClockSkew(clockSkewSeconds)
  assertFiniteTime(nowSeconds, 'nowSeconds')
  return (
    principal.expiresAt !== undefined &&
    (!Number.isFinite(principal.expiresAt) || principal.expiresAt <= nowSeconds - clockSkewSeconds)
  )
}

function normalizePrincipal(principal: McpAuthPrincipal): McpAuthPrincipal {
  if (principal.tokenType !== 'access_token') {
    throw new TypeError('The verifier result must identify an OAuth access token')
  }
  if (!principal.subject && !principal.clientId) {
    throw new TypeError('Verified principals must include a subject or client identifier')
  }

  const claims = principal.claims ? Object.freeze({ ...principal.claims }) : undefined
  const audience =
    typeof principal.audience === 'string'
      ? principal.audience
      : Object.freeze([...principal.audience])

  return Object.freeze({
    ...principal,
    audience,
    scopes: Object.freeze(uniqueScopes(principal.scopes)),
    claims
  })
}

function verifierFunction(
  verifier: McpAccessTokenVerifier | McpAccessTokenVerifierFunction
): McpAccessTokenVerifierFunction {
  return typeof verifier === 'function' ? verifier : verifier.verifyAccessToken.bind(verifier)
}

export interface AuthorizeBearerRequestOptions {
  resource: string | URL
  verifier: McpAccessTokenVerifier | McpAccessTokenVerifierFunction
  authorizationServers?: readonly (string | URL)[]
  requiredScopes?: readonly string[]
  clockSkewSeconds?: number
  now?: () => number
}

/**
 * Verifies and authorizes one request without decoding, caching, transforming,
 * or logging the supplied token.
 */
export async function authorizeBearerRequest(
  request: Request,
  options: AuthorizeBearerRequestOptions
): Promise<McpAuthorizationResult> {
  assertClockSkew(options.clockSkewSeconds ?? 0)
  const resource = options.resource instanceof URL ? options.resource.href : options.resource
  const resourceMetadata = protectedResourceMetadataUrl(options.resource)
  const parsed = parseBearerAuthorization(request.headers.get('authorization'))

  if (!parsed.ok) {
    const error = parsed.reason === 'missing' ? 'invalid_token' : 'invalid_request'
    const requiredScopes = options.requiredScopes ?? []
    return {
      ok: false,
      status: 401,
      error,
      challenge: buildBearerChallenge({
        resourceMetadata,
        ...(parsed.reason === 'malformed'
          ? {
              error,
              errorDescription: 'Malformed Authorization header'
            }
          : {}),
        ...(requiredScopes.length > 0 ? { scope: requiredScopes } : {})
      })
    }
  }

  let principal: McpAuthPrincipal
  try {
    principal = normalizePrincipal(
      await verifierFunction(options.verifier)(parsed.token, {
        request,
        resource,
        signal: request.signal
      })
    )
  } catch {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      challenge: buildBearerChallenge({
        resourceMetadata,
        error: 'invalid_token',
        errorDescription: 'Access token verification failed'
      })
    }
  }

  const nowMilliseconds = options.now?.() ?? Date.now()
  assertFiniteTime(nowMilliseconds, 'now')
  const nowSeconds = nowMilliseconds / 1000
  const trustedIssuers = options.authorizationServers?.map((issuer) =>
    issuer instanceof URL ? issuer.href : issuer
  )
  if (
    (trustedIssuers !== undefined &&
      (!principal.issuer || !trustedIssuers.includes(principal.issuer))) ||
    !isAudienceAllowed(principal, resource) ||
    isPrincipalExpired(principal, nowSeconds, options.clockSkewSeconds ?? 0)
  ) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      challenge: buildBearerChallenge({
        resourceMetadata,
        error: 'invalid_token',
        errorDescription: 'Access token is not valid for this resource'
      })
    }
  }

  const missingScopes = missingRequiredScopes(options.requiredScopes ?? [], principal.scopes)
  if (missingScopes.length > 0) {
    return {
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      missingScopes,
      challenge: buildBearerChallenge({
        resourceMetadata,
        error: 'insufficient_scope',
        errorDescription: 'Access token has insufficient scope',
        scope: options.requiredScopes ?? []
      })
    }
  }

  return {
    ok: true,
    authorization: Object.freeze({
      principal,
      scopes: principal.scopes,
      attributes: principal.claims ?? Object.freeze({})
    })
  }
}

function assertClockSkew(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError('clockSkewSeconds must be a finite non-negative number')
  }
}

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must return a finite timestamp`)
  }
}
