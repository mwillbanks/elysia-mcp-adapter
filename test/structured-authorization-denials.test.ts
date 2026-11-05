import { expect, spyOn, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import {
  createMcpAuthorizationDenialResult,
  type DetailedTask,
  type McpAuthOptions,
  type McpStructuredAuthorizationDecision,
  type McpStructuredAuthorizationDenialsOptions,
  type TaskProvider,
  MCP_STRUCTURED_AUTHORIZATION_DENIALS_REVISION,
  mcp
} from '../src/index.js'
import { modernRpc, rpc } from './helpers.js'

const authorizationKey = 'io.modelcontextprotocol/authorization'
const retryKey = 'io.modelcontextprotocol/authorization-context-id'
const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities'
const taskCapabilities = { extensions: { 'io.modelcontextprotocol/tasks': {} } }
const urlCapabilities = { elicitation: { url: {} } }
const issuer = 'https://issuer.example'
const audience = 'https://resource.example/mcp'
const auth = { authorization: 'Bearer owner' }

function verifyAccessToken(token: string): ReturnType<McpAuthOptions['verifyAccessToken']> {
  if (!['owner', 'viewer', 'other'].includes(token)) throw new Error('invalid token')
  return {
    tokenType: 'access_token',
    subject: token,
    issuer,
    audience,
    scopes: token === 'viewer' ? [] : ['payments:write'],
    expiresAt: 4_000_000_000
  }
}

function fixture(
  structuredDenials?: McpStructuredAuthorizationDenialsOptions,
  provider?: TaskProvider
) {
  const operations: unknown[] = []
  const app = new Elysia()
    .use(
      mcp({
        allowedRoutes: ['/route'],
        core: { continuation: { signingKey: 'structured-denial-fixture-key-for-tests' } },
        extensions: {
          auth: {
            resource: audience,
            authorizationServers: [issuer],
            verifyAccessToken,
            structuredDenials
          },
          ...(provider === undefined ? {} : { tasks: { provider } })
        }
      })
    )
    .mcpTool(
      'payment',
      (args) => {
        operations.push(args)
        return 'paid'
      },
      {
        inputSchema: {
          type: 'object',
          properties: { amount: { type: 'number' } },
          required: ['amount']
        },
        authorization: { requiredScopes: ['payments:write'] },
        ...(provider === undefined ? {} : { taskExecution: 'optional' as const })
      }
    )
    .post(
      '/route',
      () => {
        operations.push('route')
        return 'invoked'
      },
      {
        mcp: { name: 'route' },
        beforeHandle: () => {
          operations.push('route hook')
        },
        body: t.Object({ amount: t.Number() })
      }
    )
  return { app, operations }
}

function payment(meta: Record<string, unknown> = {}) {
  return { name: 'payment', arguments: { amount: 10 }, _meta: meta }
}

test('keeps standard OAuth and validation ahead of policy and reevaluates every retry', async () => {
  let allowed = false
  const evaluations: unknown[] = []
  const { app, operations } = fixture({
    version: MCP_STRUCTURED_AUTHORIZATION_DENIALS_REVISION,
    evaluate: (context) => {
      evaluations.push(context)
      const input = context.arguments as { amount: number }
      input.amount = 99
      return allowed
        ? { kind: 'allow' }
        : {
            kind: 'deny',
            remediation: 'unavailable',
            authorizationContextId: 'audit-1'
          }
    }
  })

  const missing = await modernRpc(app, 'tools/call', payment())
  expect(missing.status).toBe(401)
  expect(missing.headers.get('www-authenticate')).toStartWith('Bearer ')
  const insufficient = await modernRpc(app, 'tools/call', payment(), {
    authorization: 'Bearer viewer'
  })
  expect(insufficient.status).toBe(403)
  expect(insufficient.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
  const invalid = await modernRpc(
    app,
    'tools/call',
    {
      name: 'payment',
      arguments: { amount: 'invalid' }
    },
    auth
  )
  expect(invalid.body.result.isError).toBe(true)
  expect(invalid.body.result._meta[authorizationKey]).toBeUndefined()
  expect(evaluations).toEqual([])
  expect(operations).toEqual([])

  const initial = await modernRpc(app, 'tools/call', payment(), auth)
  const denial = {
    reason: 'insufficient_authorization',
    remediation: 'unavailable',
    authorizationContextId: 'audit-1'
  }
  expect(initial.body.result).toMatchObject({
    resultType: 'complete',
    isError: true,
    _meta: { [authorizationKey]: denial }
  })
  const echo = await modernRpc(app, 'tools/call', payment({ [retryKey]: 'audit-1' }), auth)
  expect(echo.body.result._meta[authorizationKey]).toEqual(denial)
  expect(evaluations).toHaveLength(2)
  expect(evaluations[1]).toMatchObject({ tool: 'payment', principal: { subject: 'owner' } })
  expect(evaluations[1]).not.toHaveProperty('meta')
  expect(evaluations[1]).not.toHaveProperty('request')
  expect(evaluations[1]).not.toHaveProperty(retryKey)
  expect(operations).toEqual([])

  allowed = true
  const retried = await modernRpc(app, 'tools/call', payment({ [retryKey]: 'unresolvable' }), auth)
  expect(retried.body.result.content).toEqual([{ type: 'text', text: 'paid' }])
  expect(operations).toEqual([{ amount: 10 }])
})

test('does not run an Elysia route hook or handler until the policy allows the call', async () => {
  let allowed = false
  const { app, operations } = fixture({
    evaluate: () => (allowed ? { kind: 'allow' } : { kind: 'deny', remediation: 'undisclosed' })
  })
  const params = { name: 'route', arguments: { body: { amount: 10 } } }
  const denied = await modernRpc(app, 'tools/call', params, auth)
  expect(denied.body.result._meta[authorizationKey]).toEqual({
    reason: 'insufficient_authorization',
    remediation: 'undisclosed'
  })
  expect(operations).toEqual([])

  allowed = true
  const result = await modernRpc(app, 'tools/call', params, auth)
  expect(result.body.result.isError).toBeUndefined()
  expect(operations).toEqual(['route hook', 'route'])
})

test('does not enable the draft implicitly or allow a legacy downgrade around policy', async () => {
  const disabled = fixture()
  expect(
    (await modernRpc(disabled.app, 'tools/call', payment(), auth)).body.result.content
  ).toEqual([{ type: 'text', text: 'paid' }])
  const enabled = fixture({ evaluate: () => ({ kind: 'deny', remediation: 'unavailable' }) })
  const legacy = await rpc(enabled.app, 'tools/call', payment(), auth)
  expect(legacy.body.result.resultType).toBeUndefined()
  expect(legacy.body.result._meta[authorizationKey].remediation).toBe('unavailable')
  expect(enabled.operations).toEqual([])
  expect(() =>
    fixture({
      version: 'previous' as 'current',
      evaluate: () => ({ kind: 'allow' })
    })
  ).toThrow('Select the current SEP-2643 revision')
})

test('serializes RAR details and the optional opaque reference only for reusable credentials', async () => {
  let singleUse = false
  const details = [{ type: 'payment', actions: ['initiate'], amount: { value: '10' } }]
  const { app, operations } = fixture({
    evaluate: () =>
      singleUse
        ? { kind: 'credential', authorizationDetails: details, singleUseCredential: true }
        : {
            kind: 'credential',
            authorizationDetails: details,
            authorizationReference: 'payments.v1.10'
          }
  })
  const reusable = await modernRpc(app, 'tools/call', payment(), auth)
  expect(reusable.body.result._meta[authorizationKey].remediationHints).toEqual([
    {
      type: 'authorization_remediation',
      authorization_details: details,
      authorization_reference: 'payments.v1.10'
    }
  ])
  singleUse = true
  const oneUse = await modernRpc(app, 'tools/call', payment(), auth)
  expect(oneUse.body.result._meta[authorizationKey].remediationHints).toEqual([
    {
      type: 'authorization_remediation',
      authorization_details: details
    }
  ])
  expect(operations).toEqual([])
})

test('gates URL remediation on capability and evaluates signed retries against fresh approval', async () => {
  const now = spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  try {
    let approved = false
    let seenState: string | undefined
    const { app, operations } = fixture({
      evaluate: ({ continuationState }) => {
        seenState = continuationState
        if (approved && continuationState === 'approval-record-1') return { kind: 'allow' }
        return {
          kind: 'url',
          url: 'https://approval.example/payments',
          message: 'Approve this payment.',
          inputKey: 'payment_approval',
          continuationState: 'approval-record-1'
        }
      }
    })
    const noCapability = await modernRpc(app, 'tools/call', payment(), auth)
    expect(noCapability.body.result._meta[authorizationKey].remediation).toBe('undisclosed')
    expect(noCapability.body.result.inputRequests).toBeUndefined()

    const params = payment({ [capabilitiesKey]: urlCapabilities })
    const initial = await modernRpc(app, 'tools/call', params, auth)
    const request = initial.body.result
    expect(request).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        payment_approval: {
          method: 'elicitation/create',
          params: {
            mode: 'url',
            url: 'https://approval.example/payments'
          }
        }
      },
      _meta: {
        [authorizationKey]: { remediation: 'available', remediationHints: [{ type: 'url' }] }
      }
    })
    expect(request.requestState).not.toBe('approval-record-1')
    const retry = {
      ...params,
      requestState: request.requestState,
      inputResponses: { payment_approval: { action: 'accept' } }
    }
    expect((await modernRpc(app, 'tools/call', retry, auth)).body.result.resultType).toBe(
      'input_required'
    )
    expect(seenState).toBe('approval-record-1')
    for (const action of ['decline', 'cancel']) {
      const stopped = await modernRpc(
        app,
        'tools/call',
        {
          ...retry,
          inputResponses: { payment_approval: { action } }
        },
        auth
      )
      expect(stopped.body.result._meta[authorizationKey].remediation).toBe('undisclosed')
      expect(stopped.body.result.inputRequests).toBeUndefined()
    }
    expect(operations).toEqual([])
    approved = true
    expect((await modernRpc(app, 'tools/call', retry, auth)).body.result.resultType).toBe(
      'complete'
    )
    expect(operations).toEqual([{ amount: 10 }])
    const other = await modernRpc(app, 'tools/call', retry, { authorization: 'Bearer other' })
    expect(other.body.error.code).toBe(-32602)
    expect(operations).toHaveLength(1)
  } finally {
    now.mockRestore()
  }
})

test('repeats the durable task envelope only for the owner and while approval is pending', async () => {
  let task: DetailedTask | undefined
  let owner: string | undefined
  let starts = 0
  const taskId = 'approval-task-1'
  const provider: TaskProvider = {
    create: async () => {
      throw new Error('original operation must not be scheduled')
    },
    get: async (id, context) =>
      id === taskId && context.principalKey === owner ? task : undefined,
    update: async () => false,
    requestInput: async () => false,
    cancel: async () => false
  }
  const { app, operations } = fixture(
    {
      evaluate: () => ({
        kind: 'task',
        authorizationContextId: 'task-audit-1',
        start: ({ principalKey, metadata, arguments: args }) => {
          starts++
          expect(args).toEqual({ amount: 10 })
          owner = principalKey
          task = {
            taskId,
            status: 'working',
            createdAt: '2026-11-05T00:00:00Z',
            lastUpdatedAt: '2026-11-05T00:00:00Z',
            ttlMs: 60_000,
            _meta: metadata
          }
          return taskId
        }
      })
    },
    provider
  )

  const unsupported = await modernRpc(app, 'tools/call', payment(), auth)
  expect(unsupported.body.result._meta[authorizationKey].remediation).toBe('undisclosed')
  expect(starts).toBe(0)

  const metadata = { [capabilitiesKey]: taskCapabilities }
  const initial = await modernRpc(app, 'tools/call', payment(metadata), auth)
  expect(initial.body.result).toMatchObject({ resultType: 'task', taskId, status: 'working' })
  expect(starts).toBe(1)
  expect(operations).toEqual([])
  const poll = { taskId, _meta: metadata }
  const pending = await modernRpc(app, 'tasks/get', poll, auth)
  expect(pending.body.result._meta[authorizationKey]).toEqual(
    initial.body.result._meta[authorizationKey]
  )
  const other = await modernRpc(app, 'tasks/get', poll, { authorization: 'Bearer other' })
  expect(other.body.result).toBeUndefined()

  if (!task) throw new Error('missing pending task')
  task = {
    ...task,
    status: 'completed',
    result: createMcpAuthorizationDenialResult('unavailable', 'task-audit-1')
  }
  const terminal = await modernRpc(app, 'tasks/get', poll, auth)
  expect(terminal.body.result._meta[authorizationKey]).toBeUndefined()
  expect(terminal.body.result.result).toMatchObject({
    isError: true,
    _meta: {
      [authorizationKey]: { remediation: 'unavailable', authorizationContextId: 'task-audit-1' }
    }
  })
  expect(operations).toEqual([])
})

test('fails closed on callback errors, unsafe hints, and malformed decisions', async () => {
  const cyclic: Record<string, unknown> = { type: 'example' }
  cyclic.self = cyclic
  let getterCalls = 0
  const accessors = {
    type: 'example',
    get secret() {
      getterCalls++
      return 'private'
    }
  }
  const outcomes: unknown[] = [
    undefined,
    { kind: 'other' },
    Object.create({ kind: 'allow' }),
    { kind: 'deny', remediation: 'available' },
    { kind: 'url', url: 'javascript:alert(1)', message: 'Open', inputKey: 'url' },
    { kind: 'credential', authorizationDetails: [cyclic] },
    { kind: 'credential', authorizationDetails: [accessors] },
    {
      kind: 'credential',
      authorizationDetails: [{ type: 'payment' }],
      singleUseCredential: true,
      authorizationReference: 'private'
    }
  ]
  let outcome: unknown
  const { app, operations } = fixture({
    evaluate: () => {
      if (outcome === 'throw') throw new Error('private')
      return outcome as McpStructuredAuthorizationDecision
    }
  })
  for (outcome of [...outcomes, 'throw']) {
    const response = await modernRpc(app, 'tools/call', payment(), auth)
    expect(response.body.error).toMatchObject({
      code: -32603,
      message: 'Structured authorization evaluation failed'
    })
    expect(JSON.stringify(response.body)).not.toContain('private')
  }
  expect(getterCalls).toBe(0)
  expect(operations).toEqual([])
})

test('rejects an approval task that is not immediately visible to its principal', async () => {
  const provider: TaskProvider = {
    create: async () => {
      throw new Error('original operation must not be scheduled')
    },
    get: async () => undefined,
    update: async () => false,
    requestInput: async () => false,
    cancel: async () => false
  }
  const { app, operations } = fixture(
    {
      evaluate: () => ({ kind: 'task', start: () => 'private-unreadable-task' })
    },
    provider
  )
  const result = await modernRpc(
    app,
    'tools/call',
    payment({ [capabilitiesKey]: taskCapabilities }),
    auth
  )
  expect(result.body.error).toMatchObject({
    code: -32603,
    message: 'Structured authorization evaluation failed'
  })
  expect(JSON.stringify(result.body)).not.toContain('private-unreadable-task')
  expect(operations).toEqual([])
})
