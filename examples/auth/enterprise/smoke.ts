import { createEnterpriseExample, enterpriseMcpCall, issueEnterpriseAccessToken } from './app.js'
import { createEphemeralIdpCertificate } from './test-certificate.js'

const example = await createEnterpriseExample({
  secret: crypto.randomUUID().repeat(2),
  samlCertificate: await createEphemeralIdpCertificate()
})
try {
  example.app.listen(43102)
  const token = await issueEnterpriseAccessToken(example)
  const response = await enterpriseMcpCall(example.app, token.access_token)
  if (!response.ok) throw new Error(`Enterprise MCP smoke failed with HTTP ${response.status}`)
} finally {
  example.app.stop()
  example.database.close()
}
