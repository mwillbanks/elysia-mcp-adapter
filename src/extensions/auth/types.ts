import type {
  MCP_CLIENT_CREDENTIALS_EXTENSION,
  MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION
} from './constants.js'

export type McpAuthProfile = 'core' | 'client-credentials' | 'enterprise-managed'

export type McpAuthVersion =
  | 'current'
  | 'draft'
  | '2026-07-28'
  | '2026-06-17'
  | '2025-11-25'
  | '2025-06-18'

export interface McpAuthPrincipal {
  /** Verified token class. ID tokens, SAML assertions, and ID-JAGs are not access tokens. */
  tokenType: 'access_token'
  /** Stable subject identifier assigned by the token issuer. */
  subject?: string
  /** Token issuer, when exposed by the verifier. */
  issuer?: string
  /** Resource server identifiers for which the access token is valid. */
  audience: string | readonly string[]
  /** Expiration as Unix time in seconds. */
  expiresAt: number
  /** Scopes granted to this access token. */
  scopes: readonly string[]
  /** OAuth client identifier, when the token represents a workload. */
  clientId?: string
  /**
   * Non-sensitive, verified claims needed by application authorization.
   * The adapter never decodes an unverified access token to populate this value.
   */
  claims?: Readonly<Record<string, unknown>>
}

export interface McpTokenVerificationContext {
  request: Request
  resource: string
  signal?: AbortSignal
}

export interface McpAccessTokenVerifier {
  verifyAccessToken(
    token: string,
    context: McpTokenVerificationContext
  ): McpAuthPrincipal | Promise<McpAuthPrincipal>
}

export type McpAccessTokenVerifierFunction = (
  token: string,
  context: McpTokenVerificationContext
) => McpAuthPrincipal | Promise<McpAuthPrincipal>

export interface McpAuthorizationContext {
  principal: Readonly<McpAuthPrincipal>
  scopes: readonly string[]
  attributes: Readonly<Record<string, unknown>>
}

export interface McpProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported?: string[]
  bearer_methods_supported?: string[]
  resource_signing_alg_values_supported?: string[]
  resource_name?: string
  resource_documentation?: string
  resource_policy_uri?: string
  resource_tos_uri?: string
  jwks_uri?: string
  tls_client_certificate_bound_access_tokens?: boolean
  authorization_details_types_supported?: string[]
  dpop_signing_alg_values_supported?: string[]
  dpop_bound_access_tokens_required?: boolean
  [key: string]: unknown
}

export interface McpProtectedResourceMetadataOptions {
  resource: string | URL
  authorizationServers: readonly (string | URL)[]
  scopesSupported?: readonly string[]
  bearerMethodsSupported?: readonly string[]
  resourceSigningAlgValuesSupported?: readonly string[]
  resourceName?: string
  resourceDocumentation?: string | URL
  resourcePolicyUri?: string | URL
  resourceTosUri?: string | URL
  jwksUri?: string | URL
  tlsClientCertificateBoundAccessTokens?: boolean
  authorizationDetailsTypesSupported?: readonly string[]
  dpopSigningAlgValuesSupported?: readonly string[]
  dpopBoundAccessTokensRequired?: boolean
  additionalMetadata?: Readonly<Record<string, unknown>>
}

export interface McpAuthProfileOptions {
  clientCredentials?: boolean | { version?: McpAuthVersion }
  enterpriseManaged?: boolean | { version?: McpAuthVersion }
}

export interface McpAuthExtensionCapabilities {
  [MCP_CLIENT_CREDENTIALS_EXTENSION]?: Record<string, never>
  [MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION]?: Record<string, never>
}

export interface McpAuthOptions {
  version?: McpAuthVersion
  resource: string | URL
  authorizationServers: readonly (string | URL)[]
  verifyAccessToken: McpAccessTokenVerifierFunction
  /** Base scopes advertised by the protected resource. */
  scopes?: readonly string[]
  /** Also serve metadata at the origin-root well-known path. */
  rootMetadataAlias?: boolean
  metadata?: Omit<McpProtectedResourceMetadataOptions, 'resource' | 'authorizationServers'>
  profiles?: McpAuthProfileOptions
  /**
   * Maximum allowed clock skew for access-token expiry checks, in seconds.
   * Defaults to zero.
   */
  clockSkewSeconds?: number
}

export type BearerAuthorizationResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'missing' | 'malformed' }

export type McpBearerChallengeError = 'invalid_request' | 'invalid_token' | 'insufficient_scope'

export interface McpBearerChallengeOptions {
  resourceMetadata: string | URL
  error?: McpBearerChallengeError
  errorDescription?: string
  scope?: readonly string[] | string
}

export interface McpAuthorizationSuccess {
  ok: true
  authorization: McpAuthorizationContext
}

export interface McpAuthorizationFailure {
  ok: false
  status: 401 | 403
  challenge: string
  error: 'invalid_request' | 'invalid_token' | 'insufficient_scope'
  missingScopes?: string[]
}

export type McpAuthorizationResult = McpAuthorizationSuccess | McpAuthorizationFailure
