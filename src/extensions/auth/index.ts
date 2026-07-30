export {
  buildBearerChallenge,
  parseBearerAuthorization
} from './bearer.js'
export {
  MCP_AUTH_VERSION_MANIFEST,
  MCP_CLIENT_CREDENTIALS_CURRENT_VERSION,
  MCP_CLIENT_CREDENTIALS_EXTENSION,
  MCP_CORE_AUTH_CURRENT_VERSION,
  MCP_ENTERPRISE_AUTH_CURRENT_VERSION,
  MCP_ENTERPRISE_GRANT_PROFILE,
  MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION
} from './constants.js'
export {
  type AuthorizeBearerRequestOptions,
  authorizeBearerRequest,
  filterAuthorizedScopes,
  isAudienceAllowed,
  isPrincipalExpired,
  missingRequiredScopes
} from './enforce.js'
export {
  buildProtectedResourceMetadata,
  protectedResourceMetadataPath,
  protectedResourceMetadataPaths,
  protectedResourceMetadataUrl
} from './metadata.js'
export { authProfileCapabilities } from './profiles.js'
export type {
  BearerAuthorizationResult,
  McpAccessTokenVerifier,
  McpAccessTokenVerifierFunction,
  McpAuthExtensionCapabilities,
  McpAuthOptions,
  McpAuthorizationContext,
  McpAuthorizationFailure,
  McpAuthorizationResult,
  McpAuthorizationSuccess,
  McpAuthPrincipal,
  McpAuthProfile,
  McpAuthProfileOptions,
  McpAuthVersion,
  McpBearerChallengeError,
  McpBearerChallengeOptions,
  McpProtectedResourceMetadata,
  McpProtectedResourceMetadataOptions,
  McpTokenVerificationContext
} from './types.js'
export { resolveAuthVersion } from './version.js'
