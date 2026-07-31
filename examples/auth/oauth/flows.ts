import { createHash, randomBytes } from 'node:crypto'
import { createOAuthClient, MCP_RESOURCE, OAUTH_BASE_URL } from './app.js'

type OAuthExample = Awaited<ReturnType<typeof import('./app.js').createOAuthExample>>

function base64url(value: Buffer): string {
  return value.toString('base64url')
}

export async function issueClientCredentialsToken(example: OAuthExample, scopes = ['mcp:read']) {
  const client = await createOAuthClient(example.auth, { scopes })
  const response = await example.app.handle(
    new Request(`${OAUTH_BASE_URL}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: client.client_id,
        client_secret: client.client_secret ?? '',
        resource: MCP_RESOURCE,
        scope: scopes.join(' ')
      })
    })
  )
  if (!response.ok) throw new Error(`client_credentials failed: ${await response.text()}`)
  return (await response.json()) as { access_token: string; scope: string; token_type: string }
}

export async function issueAuthorizationCodeToken(example: OAuthExample) {
  const client = await createOAuthClient(example.auth, { publicClient: true })
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const redirectUri = 'http://localhost:43101/callback'
  const authorizeUrl = new URL(`${OAUTH_BASE_URL}/oauth2/authorize`)
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: 'mcp:read',
    state: 'deterministic-state',
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString()
  const authorization = await example.app.handle(
    new Request(authorizeUrl, { headers: { cookie: client.ownerCookie } })
  )
  const location = authorization.headers.get('location')
  if (!location) {
    throw new Error(
      `authorization endpoint failed: ${authorization.status} ${await authorization.text()}`
    )
  }
  const redirect = new URL(location)
  const code = redirect.searchParams.get('code')
  if (!code) throw new Error(`authorization endpoint did not issue a code: ${location}`)
  const response = await example.app.handle(
    new Request(`${OAUTH_BASE_URL}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: MCP_RESOURCE
      })
    })
  )
  if (!response.ok) throw new Error(`authorization_code failed: ${await response.text()}`)
  return (await response.json()) as { access_token: string; scope: string; token_type: string }
}
