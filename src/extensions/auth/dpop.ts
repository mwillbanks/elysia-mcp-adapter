import { isRecord } from '../../internal.js'

export const MCP_DPOP_SIGNING_ALGORITHMS = Object.freeze(['ES256'] as const)
export const DPOP_PROOF_MAX_AGE_SECONDS = 300
const MAX_CREDENTIAL_LENGTH = 16_384
const MAX_AUTHORIZATION_HEADER_LENGTH = MAX_CREDENTIAL_LENGTH + 64
const ACCESS_TOKEN = /^[a-zA-Z0-9._~+/-]+=*$/u
const COMPACT_JWT = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/u
const PROOF_HEADER_FIELDS = new Set(['typ', 'alg', 'jwk', 'kid'])
const PUBLIC_JWK_FIELDS = new Set(['kty', 'crv', 'x', 'y', 'alg', 'use', 'kid', 'key_ops', 'ext'])
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface McpDpopReplayClaim {
  readonly jti: string
  readonly jkt: string
  /** Normalized proof target without a query or fragment. */
  readonly resource: string
  /** Exclusive expiry in Unix seconds. Keep the reservation until this instant. */
  readonly expiresAt: number
}

/** Atomically reserve (resource, jkt, jti). Return true only for a new reservation. */
export type McpDpopReplayAcceptor = (claim: McpDpopReplayClaim) => boolean | Promise<boolean>

interface DpopProofOptions {
  nowSeconds: number
  maxAgeSeconds?: number
  acceptReplay?: McpDpopReplayAcceptor
}

type DpopProofResult = { ok: true } | { ok: false; error: 'invalid_dpop_proof' | 'invalid_token' }

type ParsedDpopAuthorization =
  { ok: true; token: string } | { ok: false; reason: 'missing' | 'malformed' }

const INVALID_PROOF = { ok: false, error: 'invalid_dpop_proof' } as const
const INVALID_TOKEN = { ok: false, error: 'invalid_token' } as const

export function parseDpopAuthorization(header: string | null): ParsedDpopAuthorization {
  if (header === null) return { ok: false, reason: 'missing' }
  if (header.length > MAX_AUTHORIZATION_HEADER_LENGTH) {
    return { ok: false, reason: 'malformed' }
  }

  const token = /^DPoP +(\S+)$/iu.exec(header)?.[1]
  return token && isAccessToken(token) ? { ok: true, token } : { ok: false, reason: 'malformed' }
}

function isAccessToken(token: string): boolean {
  return token.length <= MAX_CREDENTIAL_LENGTH && ACCESS_TOKEN.test(token)
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string) {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64Url(bytes) !== value) throw new Error('Noncanonical base64url')
  return bytes
}

function decodeObject(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(decoder.decode(decodeBase64Url(segment)))
  if (!isRecord(value)) throw new Error('Invalid JWT object')
  return value
}

function isCoordinate(value: unknown): value is string {
  return typeof value === 'string' && value.length === 43 && decodeBase64Url(value).length === 32
}

function supportsKeyUsage(jwk: Record<string, unknown>): boolean {
  const { alg, use, key_ops: operations } = jwk
  if (alg !== undefined && alg !== 'ES256') return false
  if (use !== undefined && use !== 'sig') return false
  return (
    operations === undefined ||
    (Array.isArray(operations) && operations.length === 1 && operations[0] === 'verify')
  )
}

function hasSupportedKeyMetadata(jwk: Record<string, unknown>): boolean {
  const { kid, ext } = jwk
  return (
    (kid === undefined || typeof kid === 'string') &&
    (ext === undefined || typeof ext === 'boolean') &&
    supportsKeyUsage(jwk)
  )
}

function embeddedProofKey(header: Record<string, unknown>): Record<string, unknown> {
  const { typ, alg, jwk, kid } = header
  if (typ !== 'dpop+jwt' || alg !== MCP_DPOP_SIGNING_ALGORITHMS[0] || !isRecord(jwk)) {
    throw new Error('Unsupported proof header')
  }
  if (!Object.keys(header).every((field) => PROOF_HEADER_FIELDS.has(field))) {
    throw new Error('Unsupported proof header field')
  }
  if (kid !== undefined && typeof kid !== 'string') throw new Error('Invalid proof key ID')
  return jwk
}

function publicProofKey(header: Record<string, unknown>) {
  const jwk = embeddedProofKey(header)
  if (!Object.keys(jwk).every((field) => PUBLIC_JWK_FIELDS.has(field))) {
    throw new Error('Unsupported public key field')
  }
  if (!hasSupportedKeyMetadata(jwk)) throw new Error('Unsupported public key metadata')

  const { crv, kty, x, y } = jwk
  if (crv !== 'P-256' || kty !== 'EC' || !isCoordinate(x) || !isCoordinate(y)) {
    throw new Error('Invalid P-256 public key')
  }
  // RFC 7638 requires only the public key parameters, in lexicographic order.
  return { crv, kty, x, y }
}

function normalizeTarget(target: string): string {
  if (!/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/iu.test(target))
    throw new Error('Invalid HTTPS target URI')
  // Avoid parser recovery that could equate a malformed proof target with an actual request.
  if (/[^\x21-\x7e]|[<>"^{}|\x60\\]|%(?![a-f0-9]{2})/iu.test(target))
    throw new Error('Invalid target URI')
  const url = new URL(target)
  const [authority] = target.slice(target.indexOf('//') + 2).split('/', 1)
  if (!authority || authority.includes('@') || authority.includes('%'))
    throw new Error('Invalid target authority')
  const path = url.pathname.replace(/%[a-f0-9]{2}/giu, (escape) => {
    const character = String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    return /[a-zA-Z0-9._~-]/u.test(character) ? character : escape.toUpperCase()
  })
  return url.origin + path
}

function validateProofId(jti: unknown): asserts jti is string {
  if (typeof jti !== 'string' || jti.length > 256 || !jti.trim() || /[\x00-\x1f\x7f]/u.test(jti)) {
    throw new Error('Invalid proof ID')
  }
}

function validateProofTime(
  iat: unknown,
  nowSeconds: number,
  maxAgeSeconds: number
): asserts iat is number {
  if (
    typeof iat !== 'number' ||
    !Number.isFinite(iat) ||
    Math.abs(nowSeconds - iat) > maxAgeSeconds
  ) {
    throw new Error('Invalid proof timestamp')
  }
}

function validateClaims(
  claims: Record<string, unknown>,
  request: Request,
  nowSeconds: number,
  maxAgeSeconds: number
) {
  const { jti, htm, htu, iat, ath } = claims
  validateProofId(jti)
  validateProofTime(iat, nowSeconds, maxAgeSeconds)
  if (htm !== request.method || typeof htu !== 'string' || typeof ath !== 'string') {
    throw new Error('Invalid proof claims')
  }

  const [requestTarget] = request.url.split(/[?#]/u, 1)
  const resource = normalizeTarget(requestTarget ?? '')
  if (normalizeTarget(htu) !== resource) throw new Error('Incorrect proof target')
  return { jti, iat, ath, resource }
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return encodeBase64Url(new Uint8Array(hash))
}

export function isDpopProofMaxAge(maxAgeSeconds: number): boolean {
  return (
    Number.isFinite(maxAgeSeconds) &&
    maxAgeSeconds > 0 &&
    maxAgeSeconds <= DPOP_PROOF_MAX_AGE_SECONDS
  )
}

function isBoundedWindow(nowSeconds: number, maxAgeSeconds: number): boolean {
  return (
    Number.isFinite(nowSeconds) &&
    Math.abs(nowSeconds) < Number.MAX_SAFE_INTEGER - DPOP_PROOF_MAX_AGE_SECONDS &&
    isDpopProofMaxAge(maxAgeSeconds)
  )
}

/**
 * Validate a proof using a host-verified token confirmation thumbprint. Call
 * after validating the token, its audience and required scopes.
 */
export async function verifyDpopProof(
  request: Request,
  accessToken: string,
  expectedJkt: string | undefined,
  options: DpopProofOptions
): Promise<DpopProofResult> {
  try {
    const maxAgeSeconds = options.maxAgeSeconds ?? DPOP_PROOF_MAX_AGE_SECONDS
    if (!isBoundedWindow(options.nowSeconds, maxAgeSeconds)) return INVALID_PROOF
    if (!isAccessToken(accessToken)) return INVALID_TOKEN
    const proof = request.headers.get('dpop')
    if (!proof || proof.length > MAX_CREDENTIAL_LENGTH || !COMPACT_JWT.test(proof)) {
      return INVALID_PROOF
    }

    const [headerSegment, claimsSegment, signatureSegment] = proof.split('.')
    if (!headerSegment || !claimsSegment || !signatureSegment) return INVALID_PROOF
    const jwk = publicProofKey(decodeObject(headerSegment))
    const claims = validateClaims(
      decodeObject(claimsSegment),
      request,
      options.nowSeconds,
      maxAgeSeconds
    )
    const signature = decodeBase64Url(signatureSegment)
    if (signature.length !== 64 || claims.ath !== (await digest(accessToken))) return INVALID_PROOF

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )
    const signedInput = encoder.encode(headerSegment + '.' + claimsSegment)
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      signedInput
    )
    if (!valid) return INVALID_PROOF

    const jkt = await digest(JSON.stringify(jwk))
    if (jkt !== expectedJkt) return INVALID_TOKEN
    if (options.acceptReplay) {
      const { jti, resource, iat } = claims
      // Keep the reservation past the inclusive acceptance boundary.
      const expiresAt = iat + maxAgeSeconds + 1
      if ((await options.acceptReplay({ jti, jkt, resource, expiresAt })) !== true) {
        return INVALID_PROOF
      }
    }
    return { ok: true }
  } catch {
    return INVALID_PROOF
  }
}
