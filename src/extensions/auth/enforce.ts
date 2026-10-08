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
  const resource = typeof options.resource === 'string' ? options.resource : options.resource.href
  const resourceMetadata = protectedResourceMetadataUrl(options.resource)
  const parsed = parseBearerAuthorization(request.headers.get('authorization'))
  if (!parsed.ok) return invalidAuthorizationHeader(parsed.reason, options, resourceMetadata)
  const verified = await verifyPrincipal(parsed.token, request, resource, options, resourceMetadata)
  if (!verified.ok) return verified.result
  const principal = verified.principal

  const nowMilliseconds = options.now?.() ?? Date.now()
  assertFiniteTime(nowMilliseconds, 'now')
  const nowSeconds = nowMilliseconds / 1000
  if (!validPrincipalForRequest(principal, resource, nowSeconds, options)) {
    return invalidToken(resourceMetadata, 'Access token is not valid for this resource')
  }

  const missingScopes = missingRequiredScopes(options.requiredScopes ?? [], principal.scopes)
  if (missingScopes.length > 0) {
    return insufficientScope(resourceMetadata, missingScopes, options.requiredScopes ?? [])
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

function invalidAuthorizationHeader(
  reason: 'malformed' | 'missing',
  options: AuthorizeBearerRequestOptions,
  resourceMetadata: string | URL
): McpAuthorizationResult {
  const error = reason === 'missing' ? 'invalid_token' : 'invalid_request'
  const requiredScopes = options.requiredScopes ?? []
  return {
    ok: false,
    status: 401,
    error,
    challenge: buildBearerChallenge({
      resourceMetadata,
      ...(reason === 'malformed'
        ? { error, errorDescription: 'Malformed Authorization header' }
        : {}),
      ...(requiredScopes.length > 0 ? { scope: requiredScopes } : {})
    })
  }
}

async function verifyPrincipal(
  token: string,
  request: Request,
  resource: string,
  options: AuthorizeBearerRequestOptions,
  resourceMetadata: string | URL
): Promise<
  { ok: true; principal: McpAuthPrincipal } | { ok: false; result: McpAuthorizationResult }
> {
  try {
    const principal = await verifierFunction(options.verifier)(token, {
      request,
      resource,
      signal: request.signal
    })
    return { ok: true, principal: normalizePrincipal(principal) }
  } catch {
    return { ok: false, result: invalidToken(resourceMetadata, 'Access token verification failed') }
  }
}

function validPrincipalForRequest(
  principal: McpAuthPrincipal,
  resource: string,
  nowSeconds: number,
  options: AuthorizeBearerRequestOptions
): boolean {
  const trustedIssuers = options.authorizationServers?.map((issuer) =>
    issuer instanceof URL ? issuer.href : issuer
  )
  if (trustedIssuers !== undefined && !trustedIssuer(principal, trustedIssuers)) return false
  if (!isAudienceAllowed(principal, resource)) return false
  return !isPrincipalExpired(principal, nowSeconds, options.clockSkewSeconds ?? 0)
}

function trustedIssuer(principal: McpAuthPrincipal, trusted: readonly string[]): boolean {
  return typeof principal.issuer === 'string' && trusted.includes(principal.issuer)
}

function invalidToken(
  resourceMetadata: string | URL,
  errorDescription: string
): McpAuthorizationResult {
  return {
    ok: false,
    status: 401,
    error: 'invalid_token',
    challenge: buildBearerChallenge({ resourceMetadata, error: 'invalid_token', errorDescription })
  }
}

function insufficientScope(
  resourceMetadata: string | URL,
  missingScopes: string[],
  requiredScopes: readonly string[]
): McpAuthorizationResult {
  return {
    ok: false,
    status: 403,
    error: 'insufficient_scope',
    missingScopes,
    challenge: buildBearerChallenge({
      resourceMetadata,
      error: 'insufficient_scope',
      errorDescription: 'Access token has insufficient scope',
      scope: requiredScopes
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
