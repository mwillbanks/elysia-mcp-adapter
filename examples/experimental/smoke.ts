import { MCP_SERVER_VARIANTS_ID } from '@mwillbanks/elysia-mcp-adapter'
import { legacyRpc } from './client.js'
import { cardApp, runLocalInterceptorExamples, variantApp } from './server.js'

const card = await cardApp.handle(new Request('http://localhost/mcp/server-card'))
if (!card.ok || !card.headers.get('etag')) throw new Error('Server card smoke check failed')
const interceptors = await runLocalInterceptorExamples()
if ((interceptors.audit.payload as string[])[0] !== 'ordered')
  throw new Error('Interceptor smoke check failed')
const initialized = await legacyRpc(variantApp, 'initialize', {
  protocolVersion: '2025-11-25',
  clientInfo: { name: 'smoke', version: '1' },
  capabilities: { extensions: { [MCP_SERVER_VARIANTS_ID]: {} } }
})
if (!initialized.response.headers.get('mcp-session-id'))
  throw new Error('Variant smoke check failed')
