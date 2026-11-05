import {
  buildBearerChallenge,
  buildDpopChallenge,
  type McpDpopChallengeOptions,
  parseBearerAuthorization
} from './bearer.js'
import {
  type McpDpopOptions,
  type NormalizedMcpDpopOptions,
  normalizeDpopOptions
} from './dpop-options.js'
import { parseDpopAuthorization, verifyDpopProof } from './dpop.js'
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

export interface AuthorizeOAuthRequestOptions extends AuthorizeBearerRequestOptions {
  dpop?: McpDpopOptions
}

type OAuthScheme = 'Bearer' | 'DPoP'

interface ChallengeTarget {
  resourceMetadata: URL
  scheme: OAuthScheme | undefined
  dpop: NormalizedMcpDpopOptions | undefined
}

/**
 * Verifies a Bearer credential without decoding, caching, transforming, or logging
 * the supplied token. A host-identified DPoP-bound token cannot be used as Bearer.
 */
export function authorizeBearerRequest(
  request: Request,
  options: AuthorizeBearerRequestOptions
): Promise<McpAuthorizationResult> {
  return authorizeTokenRequest(request, options, false)
}

/** Authorizes one protected HTTP request with the configured OAuth schemes. */
export async function authorizeOAuthRequest(
  request: Request,
  options: AuthorizeOAuthRequestOptions
): Promise<McpAuthorizationResult> {
  return authorizeTokenRequest(request, options, true, normalizeDpopOptions(options.dpop))
}

function attemptedScheme(header: string | null): OAuthScheme | undefined {
  if (!header || header.includes(',')) return undefined
  if (/^DPoP(?:\s|$)/iu.test(header)) return 'DPoP'
  if (/^Bearer(?:\s|$)/iu.test(header)) return 'Bearer'
  return undefined
}

async function authorizeTokenRequest(
  request: Request,
  options: AuthorizeBearerRequestOptions,
  rejectQueryToken: boolean,
  dpop?: NormalizedMcpDpopOptions
): Promise<McpAuthorizationResult> {
  assertClockSkew(options.clockSkewSeconds ?? 0)
  const header = request.headers.get('authorization')
  const scheme = attemptedScheme(header)
  const target = { resourceMetadata: protectedResourceMetadataUrl(options.resource), scheme, dpop }
  if (rejectQueryToken && new URL(request.url).searchParams.has('access_token')) {
    return denyAuthorization(target, {
      error: 'invalid_request',
      errorDescription: 'Query-string access tokens are not accepted'
    })
  }

  const requiredScopes = options.requiredScopes ?? []
  const credential = selectCredential(header, target, requiredScopes)
  if (!credential.ok) return credential.failure
  return authorizeCredential(request, credential.token, options, target, requiredScopes)
}

function selectCredential(
  header: string | null,
  target: ChallengeTarget,
  requiredScopes: readonly string[]
): { ok: true; token: string } | { ok: false; failure: McpAuthorizationResult } {
  const { scheme, dpop } = target
  const parsed =
    scheme === 'DPoP' && dpop ? parseDpopAuthorization(header) : parseBearerAuthorization(header)
  if (!parsed.ok) {
    return { ok: false, failure: invalidAuthorizationHeader(target, parsed.reason, requiredScopes) }
  }
  if (dpop?.required && scheme !== 'DPoP') {
    return {
      ok: false,
      failure: invalidToken(target, 'This resource requires a DPoP-bound access token')
    }
  }
  return parsed
}

function authorizationTime(now: AuthorizeBearerRequestOptions['now']): number {
  const nowMilliseconds = now?.() ?? Date.now()
  assertFiniteTime(nowMilliseconds, 'now')
  return nowMilliseconds / 1000
}

async function authorizeCredential(
  request: Request,
  token: string,
  options: AuthorizeBearerRequestOptions,
  target: ChallengeTarget,
  requiredScopes: readonly string[]
): Promise<McpAuthorizationResult> {
  const resource = typeof options.resource === 'string' ? options.resource : options.resource.href
  const principal = await verifyPrincipal(token, request, resource, options)
  if (!principal) return invalidToken(target, 'Access token verification failed')
  if (target.scheme !== 'DPoP' && principal.dpopJkt !== undefined) {
    return invalidToken(target, 'DPoP-bound access tokens require the DPoP scheme')
  }

  const nowSeconds = authorizationTime(options.now)
  if (!validPrincipalForRequest(principal, resource, nowSeconds, options)) {
    return invalidToken(target, 'Access token is not valid for this resource')
  }

  const missingScopes = missingRequiredScopes(requiredScopes, principal.scopes)
  const proofFailure = await verifyRequestProof(
    request,
    token,
    principal,
    target,
    nowSeconds,
    missingScopes.length === 0
  )
  if (proofFailure) return proofFailure
  return authorizeScopes(target, principal, requiredScopes, missingScopes)
}

function authorizeScopes(
  target: ChallengeTarget,
  principal: McpAuthPrincipal,
  requiredScopes: readonly string[],
  missingScopes: string[]
): McpAuthorizationResult {
  if (missingScopes.length > 0) {
    return denyAuthorization(
      target,
      {
        error: 'insufficient_scope',
        errorDescription: 'Access token has insufficient scope',
        scope: requiredScopes
      },
      missingScopes
    )
  }

  return {
    ok: true,
    authorization: Object.freeze({
      principal,
      scopes: principal.scopes,
      attributes: principal.claims ?? Object.freeze({}),
      ...(target.scheme === 'DPoP' ? { scheme: 'DPoP' as const } : {})
    })
  }
}

function invalidAuthorizationHeader(
  target: ChallengeTarget,
  reason: 'malformed' | 'missing',
  requiredScopes: readonly string[]
): McpAuthorizationResult {
  return denyAuthorization(target, {
    ...(reason === 'malformed'
      ? { error: 'invalid_request' as const, errorDescription: 'Malformed Authorization header' }
      : {}),
    ...(requiredScopes.length > 0 ? { scope: requiredScopes } : {})
  })
}

async function verifyPrincipal(
  token: string,
  request: Request,
  resource: string,
  options: AuthorizeBearerRequestOptions
): Promise<McpAuthPrincipal | undefined> {
  try {
    const principal = await verifierFunction(options.verifier)(token, {
      request,
      resource,
      signal: request.signal
    })
    return normalizePrincipal(principal)
  } catch {
    return undefined
  }
}

async function verifyRequestProof(
  request: Request,
  token: string,
  principal: McpAuthPrincipal,
  target: ChallengeTarget,
  nowSeconds: number,
  hasRequiredScopes: boolean
): Promise<McpAuthorizationResult | undefined> {
  if (target.scheme !== 'DPoP' || !target.dpop) return undefined
  const result = await verifyDpopProof(request, token, principal.dpopJkt, {
    nowSeconds,
    maxAgeSeconds: target.dpop.maxAgeSeconds,
    acceptReplay: hasRequiredScopes ? target.dpop.acceptReplay : undefined
  })
  if (result.ok) return undefined
  if (result.error === 'invalid_token') return invalidToken(target, 'Invalid DPoP key binding')
  return denyAuthorization(target, {
    error: result.error,
    errorDescription: 'DPoP proof verification failed'
  })
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

type ChallengeDetails = Omit<McpDpopChallengeOptions, 'resourceMetadata'>

function invalidToken(target: ChallengeTarget, errorDescription: string): McpAuthorizationResult {
  return denyAuthorization(target, { error: 'invalid_token', errorDescription })
}

function denyAuthorization(
  target: ChallengeTarget,
  details: ChallengeDetails,
  missingScopes?: string[]
): McpAuthorizationResult {
  const status = details.error === 'insufficient_scope' ? 403 : 401
  return {
    ok: false,
    status,
    error: details.error ?? 'invalid_token',
    challenge: admissionChallenge(target, details),
    ...(missingScopes ? { missingScopes } : {})
  }
}

function admissionChallenge(target: ChallengeTarget, details: ChallengeDetails): string {
  const { resourceMetadata, scheme, dpop } = target
  const challenged = { ...details, resourceMetadata }
  if (dpop?.required || (scheme === 'DPoP' && details.error === 'insufficient_scope')) {
    return buildDpopChallenge(challenged)
  }

  const { error, ...bearerParameters } = challenged
  const bearer =
    error === 'invalid_dpop_proof' ? { resourceMetadata } : { ...bearerParameters, error }
  if (!dpop || error === 'insufficient_scope') return buildBearerChallenge(bearer)
  return mixedAdmissionChallenge(scheme, bearer, challenged)
}

function mixedAdmissionChallenge(
  scheme: OAuthScheme | undefined,
  bearer: Parameters<typeof buildBearerChallenge>[0],
  dpop: McpDpopChallengeOptions
): string {
  const discovery = { resourceMetadata: dpop.resourceMetadata }
  return [
    buildBearerChallenge(scheme === 'DPoP' ? discovery : bearer),
    buildDpopChallenge(scheme === 'Bearer' ? discovery : dpop)
  ].join(', ')
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
