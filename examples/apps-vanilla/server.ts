import { MCP_APPS_RESOURCE_MIME_TYPE, mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'

const appUri = 'ui://weather/index.html'
const html = await Bun.file(new URL('./dist/index.html', import.meta.url)).text()

const app = new Elysia()
  .use(mcp({ allowedRoutes: [], extensions: { apps: {} } }))
  .mcpTool(
    'weather.open',
    () => ({
      content: [{ type: 'text', text: 'Chicago is 72°F and clear.' }],
      structuredContent: { location: 'Chicago', temperature: 72, conditions: 'Clear' }
    }),
    {
      description: 'Open the current weather view',
      app: { resourceUri: appUri, visibility: ['model', 'app'] }
    }
  )
  .mcpTool(
    'weather.refresh',
    () => ({
      content: [{ type: 'text', text: 'Weather refreshed.' }],
      structuredContent: {
        location: 'Chicago',
        temperature: 73,
        conditions: 'Mostly clear'
      }
    }),
    {
      description: 'Refresh the open weather view',
      app: { resourceUri: appUri, visibility: ['app'] }
    }
  )
  .mcpResource(
    appUri,
    () => ({
      contents: [{ uri: appUri, mimeType: MCP_APPS_RESOURCE_MIME_TYPE, text: html }]
    }),
    {
      name: 'weather-app',
      mimeType: MCP_APPS_RESOURCE_MIME_TYPE,
      app: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: true
      }
    }
  )

if (import.meta.main) app.listen(3000)

export { app }
