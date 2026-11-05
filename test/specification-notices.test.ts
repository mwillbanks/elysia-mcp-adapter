import { logs, SeverityNumber, type LogRecord } from '@opentelemetry/api-logs'
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Elysia } from 'elysia'
import {
  createMcpSubscriptionPublisher,
  MCP_ACTION_METADATA_ID,
  MCP_TRUST_ANNOTATIONS_ID,
  mcp,
  mcpInput
} from '../src/index.js'
import {
  MCP_SPECIFICATION_INVENTORY,
  MCP_SPECIFICATION_LIFECYCLE
} from '../src/extensions/governance.js'
import {
  createSpecificationNoticeReporter,
  type McpSpecificationNotice
} from '../src/extensions/specification-notices.js'
import type { DetailedTask, TaskProvider } from '../src/extensions/tasks/index.js'
import { modernRpc } from './helpers.js'

afterEach(() => {
  logs.disable()
  mock.restore()
})

describe('MCP specification notices', () => {
  test('uses separate reporters when a plugin factory is installed on two applications', async () => {
    const onNotice = mock((_notice: McpSpecificationNotice) => {})
    const install = mcp({
      core: { logging: true },
      diagnostics: { specificationNotices: { onNotice } }
    })
    const first = new Elysia().use(install)
    const second = new Elysia().use(install)
    expect(onNotice).toHaveBeenCalledTimes(2)
    expect(onNotice.mock.calls[0]?.[0]).toMatchObject({
      code: 'MCP_SPECIFICATION_DEPRECATED',
      featureId: MCP_SPECIFICATION_LIFECYCLE.logging.featureId
    })
    for (const app of [first, second]) {
      const result = await modernRpc(app, 'server/discover')
      expect(JSON.stringify(result.body)).not.toContain('MCP_SPECIFICATION_')
    }
    expect(onNotice).toHaveBeenCalledTimes(2)
  })

  test('reports host-owned annotation use and validated Roots requests once', async () => {
    const notices: McpSpecificationNotice[] = []
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          diagnostics: {
            specificationNotices: {
              onNotice: (notice) => {
                notices.push(notice)
              }
            }
          }
        })
      )
      .mcpTool(
        'annotated',
        () => ({
          content: [{ type: 'text', text: 'ok' }],
          _meta: { [MCP_TRUST_ANNOTATIONS_ID]: { sensitive: false } }
        }),
        { annotations: { [MCP_ACTION_METADATA_ID]: { outcome: 'benign' } } }
      )
      .mcpTool('roots', () => ({
        resultType: 'input_required',
        inputRequests: { directories: mcpInput.roots() }
      }))
    expect(notices).toEqual([])
    for (let attempt = 0; attempt < 2; attempt++) {
      await modernRpc(app, 'tools/list')
      await modernRpc(app, 'tools/call', { name: 'annotated' })
      const roots = await modernRpc(app, 'tools/call', {
        name: 'roots',
        _meta: { 'io.modelcontextprotocol/clientCapabilities': { roots: {} } }
      })
      expect(roots.body.result.resultType).toBe('input_required')
    }
    expect(notices.map(({ featureId, severity }) => [featureId, severity])).toEqual([
      [MCP_ACTION_METADATA_ID, 'info'],
      [MCP_TRUST_ANNOTATIONS_ID, 'info'],
      [MCP_SPECIFICATION_LIFECYCLE.roots.featureId, 'warn']
    ])
  })

  test.each(['creation', 'task subscription', 'mixed subscription'] as const)(
    'reports pending task input on %s and deduplicates it during polling',
    async (delivery) => {
      const onNotice = mock((_notice: McpSpecificationNotice) => {})
      const task: DetailedTask = {
        taskId: 'pending-deprecations',
        status: 'input_required',
        createdAt: '2026-07-28T12:00:00.000Z',
        lastUpdatedAt: '2026-07-28T12:00:00.000Z',
        ttlMs: null,
        inputRequests: {
          directories: { method: 'roots/list' },
          completion: {
            method: 'sampling/createMessage',
            params: {
              messages: [{ role: 'user', content: { type: 'text', text: 'Test' } }],
              maxTokens: 10
            }
          }
        }
      }
      const provider: TaskProvider = {
        create: async () => task,
        get: async () => task,
        requestInput: async () => false,
        update: async () => false,
        cancel: async () => false,
        async listen(_ids, listener) {
          await listener(task)
          return { close() {} }
        }
      }
      const mixed = delivery === 'mixed subscription'
      const app = new Elysia()
        .use(
          mcp({
            extensions: { tasks: { provider } },
            core: mixed
              ? {
                  subscriptions: {
                    provider: createMcpSubscriptionPublisher().provider,
                    toolsListChanged: true
                  }
                }
              : undefined,
            diagnostics: { specificationNotices: { onNotice } }
          })
        )
        .mcpTool('pending', () => 'unused', { taskExecution: 'required' })
      const _meta = {
        'io.modelcontextprotocol/clientCapabilities': {
          roots: {},
          sampling: {},
          extensions: { 'io.modelcontextprotocol/tasks': {} }
        }
      }
      const expectedWarnings = [
        MCP_SPECIFICATION_LIFECYCLE.roots.featureId,
        MCP_SPECIFICATION_LIFECYCLE.sampling.featureId
      ]
      const warningIds = () =>
        onNotice.mock.calls.flatMap(([notice]) =>
          notice.severity === 'warn' ? [notice.featureId] : []
        )

      if (delivery === 'creation') {
        const created = await modernRpc(app, 'tools/call', { name: 'pending', _meta })
        expect(created.body.result).toMatchObject({
          resultType: 'task',
          status: 'input_required',
          taskId: task.taskId
        })
      } else {
        const timer = 1 as unknown as ReturnType<typeof setInterval>
        const setHeartbeat = spyOn(globalThis, 'setInterval').mockReturnValue(timer)
        const clearHeartbeat = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
        const response = await app.handle(
          new Request('http://localhost/mcp', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'mcp-protocol-version': '2026-07-28',
              'mcp-method': 'subscriptions/listen'
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'task-notices',
              method: 'subscriptions/listen',
              params: {
                notifications: {
                  taskIds: [task.taskId],
                  ...(mixed ? { toolsListChanged: true } : {})
                },
                _meta: {
                  ..._meta,
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientInfo': { name: 'notice-tests', version: '1.0.0' }
                }
              }
            })
          })
        )
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        try {
          expect(decoder.decode((await reader.read()).value)).toContain(
            'notifications/subscriptions/acknowledged'
          )
          const notification = decoder.decode((await reader.read()).value)
          expect(notification).toContain('notifications/tasks')
          expect(notification).toContain(task.taskId)
          expect(notification).not.toContain('MCP_SPECIFICATION_')
        } finally {
          await reader.cancel()
        }
        expect(setHeartbeat).toHaveBeenCalledTimes(mixed ? 1 : 0)
        expect(clearHeartbeat).toHaveBeenCalledTimes(mixed ? 1 : 0)
      }
      expect(warningIds()).toEqual(expectedWarnings)
      const polled = await modernRpc(app, 'tasks/get', { taskId: task.taskId, _meta })
      expect(polled.body.result.status).toBe('input_required')
      expect(warningIds()).toEqual(expectedWarnings)
    }
  )

  test('reports only the selected draft and approved Beta pins at activation', () => {
    const onNotice = mock((_notice: McpSpecificationNotice) => {})
    const diagnostics = { specificationNotices: { onNotice } }
    new Elysia().use(mcp({ extensions: { apps: {}, skills: {} }, diagnostics }))
    new Elysia().use(
      mcp({
        extensions: {
          apps: { version: 'draft' },
          skills: { version: '167da6c0d42c247a8f8470228a10ca711e3f6c45' }
        },
        diagnostics
      })
    )
    expect(onNotice.mock.calls.map(([notice]) => [notice.featureId, notice.revision])).toEqual([
      ['io.modelcontextprotocol/skills', MCP_SPECIFICATION_INVENTORY.skills.source.revision],
      [
        'io.modelcontextprotocol/skills',
        MCP_SPECIFICATION_INVENTORY.skillsHistorical.source.revision
      ],
      ['io.modelcontextprotocol/ui', MCP_SPECIFICATION_INVENTORY.appsDraft.source.revision]
    ])
  })

  test('uses structured console output once per feature and instance', () => {
    const chunks: string[] = []
    const stderr = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk))
      return true
    })
    const report = createSpecificationNoticeReporter()
    const { repository, revision, path } = MCP_SPECIFICATION_INVENTORY.skills.source
    report('skills')
    report('skills')
    report('websocket')
    report('apps')

    expect(stderr).toHaveBeenCalledTimes(1)
    expect(JSON.parse(chunks.join(''))).toEqual({
      code: 'MCP_SPECIFICATION_PRE_RELEASE',
      severity: 'info',
      featureId: 'io.modelcontextprotocol/skills',
      revision,
      sourceUrl: `${repository}/blob/${revision}/${path}`
    })

    createSpecificationNoticeReporter()('skills')
    expect(stderr).toHaveBeenCalledTimes(2)
  })

  test('warns instead of issuing a prerelease notice for a deprecated experiment', () => {
    const onNotice = mock((_notice: McpSpecificationNotice) => {})
    const report = createSpecificationNoticeReporter({ onNotice })
    report('serverVariants')
    report('serverVariants')

    const { adapterRemoval, ...record } = MCP_SPECIFICATION_LIFECYCLE.serverVariants
    expect(adapterRemoval).toBe('later minor')
    expect(onNotice).toHaveBeenCalledTimes(1)
    expect(onNotice).toHaveBeenCalledWith({
      ...record,
      code: 'MCP_SPECIFICATION_DEPRECATED',
      severity: 'warn'
    })
  })

  test('can enable the host Logs provider independently of local output', () => {
    const emit = mock((_record: LogRecord) => {})
    const getLogger = mock(() => ({ emit, enabled: () => true }))
    const onNotice = mock((_notice: McpSpecificationNotice) => {})
    logs.setGlobalLoggerProvider({ getLogger })
    const report = createSpecificationNoticeReporter({
      local: false,
      openTelemetry: true,
      onNotice
    })

    report('roots')
    report('roots')
    expect(onNotice).not.toHaveBeenCalled()
    expect(getLogger).toHaveBeenCalledWith('@mwillbanks/elysia-mcp-adapter', undefined, undefined)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      severityNumber: SeverityNumber.WARN,
      severityText: 'WARN',
      body: 'MCP_SPECIFICATION_DEPRECATED',
      attributes: {
        'mcp.specification.code': 'MCP_SPECIFICATION_DEPRECATED',
        'mcp.specification.feature': MCP_SPECIFICATION_LIFECYCLE.roots.featureId,
        'mcp.specification.revision': MCP_SPECIFICATION_LIFECYCLE.roots.revision,
        'mcp.specification.source': MCP_SPECIFICATION_LIFECYCLE.roots.sourceUrl,
        'mcp.specification.migration': MCP_SPECIFICATION_LIFECYCLE.roots.migration
      }
    })
  })

  test('documents the catalog identifiers and migration for every runtime warning', async () => {
    const source = await Bun.file(
      new URL('../website/content/docs/core-concepts/specification-notices.mdx', import.meta.url)
    ).text()
    const rows = source.split('\n').flatMap((line) => {
      if (!line.startsWith('| `')) return []
      const [, id, migration] = line.split('|')
      return [[id?.trim().slice(1, -1), migration?.trim()]]
    })
    const { dynamicClientRegistration, legacyHttpSse, ...runtimeWarnings } =
      MCP_SPECIFICATION_LIFECYCLE
    expect(rows).toEqual(
      Object.values(runtimeWarnings).map(({ featureId, migration }) => [featureId, migration])
    )
    expect(dynamicClientRegistration.migration).toContain('Client ID Metadata')
    expect(legacyHttpSse.migration).toContain('Streamable HTTP')
  })

  test('isolates failures from synchronous, asynchronous, and telemetry sinks', async () => {
    const emit = mock(() => {
      throw new Error('provider failure')
    })
    logs.setGlobalLoggerProvider({ getLogger: () => ({ emit, enabled: () => true }) })

    const sync = createSpecificationNoticeReporter({
      onNotice: () => {
        throw new Error('callback failure')
      },
      openTelemetry: true
    })
    const asynchronous = createSpecificationNoticeReporter({
      onNotice: async () => {
        throw new Error('callback rejection')
      },
      openTelemetry: true
    })
    expect(() => sync('skills')).not.toThrow()
    expect(() => asynchronous('skills')).not.toThrow()
    await Promise.resolve()
    expect(emit).toHaveBeenCalledTimes(2)
  })
})
