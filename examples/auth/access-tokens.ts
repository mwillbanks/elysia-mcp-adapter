import { oauthProvider } from '@better-auth/oauth-provider'
import type { McpAuthPrincipal } from '@mwillbanks/elysia-mcp-adapter'
import { verifyJwsAccessToken } from 'better-auth/oauth2'

export function exampleOAuthProvider(resource: string, scopes: string[]) {
  return oauthProvider({
    loginPage: '/sign-in',
    consentPage: '/consent',
    silenceWarnings: { oauthAuthServerConfig: true },
    clientPrivileges: ({ action, session, user }) =>
      Boolean(
        session?.userId === user?.id &&
          (action === 'create' || action === 'configure-client-credentials-scopes')
      ),
    scopes,
    validAudiences: [resource],
    resources: [resource],
    clientRegistrationDefaultResources: [resource],
    clientCredentialGrantDefaultScopes: ['mcp:read'],
    customAccessTokenClaims: ({ resources }) => ({
      'https://example.local/token-kind': 'access_token',
      resource: resources?.[0]
    })
  })
}

interface AccessTokenPolicy {
  issuer: string
  resource: string
  invalidTokenMessage: string
  acceptArrayScopes?: boolean
  includeGrantType?: boolean
}

type AccessTokenPayload = Awaited<ReturnType<typeof verifyJwsAccessToken>>

export function exampleAccessTokenVerifier(policy: AccessTokenPolicy) {
  return async (token: string): Promise<McpAuthPrincipal> => {
    const payload = await verifyJwsAccessToken(token, {
      jwksFetch: `${policy.issuer}/jwks`,
      verifyOptions: { issuer: policy.issuer, audience: policy.resource }
    })
    if (payload['https://example.local/token-kind'] !== 'access_token' || !payload.exp)
      throw new Error(policy.invalidTokenMessage)
    const scopes = accessTokenScopes(payload.scope, policy.acceptArrayScopes)
    if (!scopes.includes('mcp:read')) throw new Error('Access token lacks the mcp:read scope')
    return accessTokenPrincipal(payload, payload.exp, scopes, policy.includeGrantType)
  }
}

function accessTokenScopes(scope: unknown, acceptArrayScopes = false): string[] {
  if (acceptArrayScopes && Array.isArray(scope))
    return scope.filter((value): value is string => typeof value === 'string')
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : []
}

function accessTokenPrincipal(
  payload: AccessTokenPayload,
  expiresAt: number,
  scopes: string[],
  includeGrantType = false
): McpAuthPrincipal {
  return {
    tokenType: 'access_token',
    subject: payload.sub,
    issuer: payload.iss,
    audience: payload.aud ?? [],
    expiresAt,
    scopes,
    clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined,
    ...(includeGrantType ? { claims: { grantType: payload.gty } } : {})
  }
}
