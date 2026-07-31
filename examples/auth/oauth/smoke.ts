import { createOAuthExample, mcpCall } from './app.js'
import { issueClientCredentialsToken } from './flows.js'

const example = await createOAuthExample({ secret: crypto.randomUUID().repeat(2) })
try {
  example.app.listen(43101)
  const token = await issueClientCredentialsToken(example)
  const response = await mcpCall(example.app, token.access_token)
  if (!response.ok) throw new Error(`OAuth MCP smoke failed with HTTP ${response.status}`)
} finally {
  example.app.stop()
  example.database.close()
}
