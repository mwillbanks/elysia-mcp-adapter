import { MCP_APPS_RESOURCE_MIME_TYPE, mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'

const appUri = 'ui://tasks/index.html'
// fallow-ignore-next-line unresolved-import
const html = await Bun.file(new URL('./dist/index.html', import.meta.url)).text()
let tasks = [
  { id: 'design', title: 'Review the MCP Apps contract', done: true },
  { id: 'ship', title: 'Ship the adapter integration', done: false }
]

const result = () => ({
  content: [
    {
      type: 'text' as const,
      text: `${tasks.filter((task) => !task.done).length} tasks remain.`
    }
  ],
  structuredContent: { tasks }
})

const app = new Elysia()
  .use(mcp({ allowedRoutes: [], extensions: { apps: {} } }))
  .mcpTool('tasks.open', result, {
    description: 'Open the task board',
    app: { resourceUri: appUri, visibility: ['model', 'app'] }
  })
  .mcpTool(
    'tasks.toggle',
    ({ id, done }: { id: string; done: boolean }) => {
      tasks = tasks.map((task) => (task.id === id ? { ...task, done } : task))
      return result()
    },
    {
      description: 'Update a task from the open task board',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, done: { type: 'boolean' } },
        required: ['id', 'done'],
        additionalProperties: false
      },
      app: { resourceUri: appUri, visibility: ['app'] }
    }
  )
  .mcpResource(
    appUri,
    () => ({
      contents: [{ uri: appUri, mimeType: MCP_APPS_RESOURCE_MIME_TYPE, text: html }]
    }),
    {
      name: 'tasks-app',
      mimeType: MCP_APPS_RESOURCE_MIME_TYPE,
      app: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: true
      }
    }
  )

if (import.meta.main) app.listen(3000)

export { app }
