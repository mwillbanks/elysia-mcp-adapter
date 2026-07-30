import type { McpProtectedResourceMetadata, McpProtectedResourceMetadataOptions } from './types.js'

const WELL_KNOWN_PROTECTED_RESOURCE = '/.well-known/oauth-protected-resource'

function resourceUrl(resource: string | URL): URL {
  const url = new URL(resource)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new TypeError('Protected resource identifiers must use HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      'Protected resource identifiers cannot contain credentials, query, or fragment'
    )
  }
  return url
}

function metadataString(value: string | URL): string {
  return value instanceof URL ? value.href : value
}

function authorizationServerString(value: string | URL): string {
  const raw = metadataString(value)
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new TypeError('Authorization server identifiers must use HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      'Authorization server identifiers cannot contain credentials, query, or fragment'
    )
  }
  return raw
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * Builds the RFC 9728 well-known path for a resource identifier.
 *
 * A resource at `/mcp` is advertised from
 * `/.well-known/oauth-protected-resource/mcp`.
 */
export function protectedResourceMetadataPath(resource: string | URL): string {
  const url = resourceUrl(resource)
  const suffix = url.pathname === '/' ? '' : url.pathname
  return `${WELL_KNOWN_PROTECTED_RESOURCE}${suffix}`
}

export function protectedResourceMetadataUrl(resource: string | URL): URL {
  const url = resourceUrl(resource)
  url.pathname = protectedResourceMetadataPath(url)
  return url
}

export function protectedResourceMetadataPaths(
  resource: string | URL,
  rootAlias = false
): string[] {
  const canonicalPath = protectedResourceMetadataPath(resource)
  if (!rootAlias || canonicalPath === WELL_KNOWN_PROTECTED_RESOURCE) {
    return [canonicalPath]
  }
  return [canonicalPath, WELL_KNOWN_PROTECTED_RESOURCE]
}

/**
 * Produces an RFC 9728 protected-resource metadata document. Extension fields
 * are permitted, but cannot override the authoritative resource or
 * authorization-server values.
 */
export function buildProtectedResourceMetadata(
  options: McpProtectedResourceMetadataOptions
): McpProtectedResourceMetadata {
  const resource = resourceUrl(options.resource).href
  const authorizationServers = unique(options.authorizationServers.map(authorizationServerString))

  if (authorizationServers.length === 0) {
    throw new TypeError('At least one authorization server is required')
  }

  const metadata: McpProtectedResourceMetadata = {
    ...options.additionalMetadata,
    resource,
    authorization_servers: authorizationServers
  }

  if (options.scopesSupported) {
    metadata.scopes_supported = unique(options.scopesSupported)
  }
  if (options.bearerMethodsSupported) {
    metadata.bearer_methods_supported = unique(options.bearerMethodsSupported)
  }
  if (options.resourceSigningAlgValuesSupported) {
    metadata.resource_signing_alg_values_supported = unique(
      options.resourceSigningAlgValuesSupported
    )
  }
  if (options.resourceName !== undefined) {
    metadata.resource_name = options.resourceName
  }
  if (options.resourceDocumentation !== undefined) {
    metadata.resource_documentation = metadataString(options.resourceDocumentation)
  }
  if (options.resourcePolicyUri !== undefined) {
    metadata.resource_policy_uri = metadataString(options.resourcePolicyUri)
  }
  if (options.resourceTosUri !== undefined) {
    metadata.resource_tos_uri = metadataString(options.resourceTosUri)
  }
  if (options.jwksUri !== undefined) {
    metadata.jwks_uri = metadataString(options.jwksUri)
  }
  if (options.tlsClientCertificateBoundAccessTokens !== undefined) {
    metadata.tls_client_certificate_bound_access_tokens =
      options.tlsClientCertificateBoundAccessTokens
  }
  if (options.authorizationDetailsTypesSupported) {
    metadata.authorization_details_types_supported = unique(
      options.authorizationDetailsTypesSupported
    )
  }
  if (options.dpopSigningAlgValuesSupported) {
    metadata.dpop_signing_alg_values_supported = unique(options.dpopSigningAlgValuesSupported)
  }
  if (options.dpopBoundAccessTokensRequired !== undefined) {
    metadata.dpop_bound_access_tokens_required = options.dpopBoundAccessTokensRequired
  }

  return metadata
}
