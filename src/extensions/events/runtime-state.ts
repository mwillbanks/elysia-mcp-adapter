import type { AnyElysiaApp, McpInvocationContext, NormalizedMcpPluginOptions } from '../../types.js'
import type { McpEventDefinition } from './types.js'

export interface WebhookWorkerState {
  abort: AbortController
  cursor: string | null
  context: McpInvocationContext
  definition: McpEventDefinition
  done: Promise<void>
  initialProcessed: Promise<void>
  epoch: bigint
  terminal: boolean
  persisting?: Promise<void>
  refreshGate?: Promise<void>
}

interface EventRuntimeState {
  workers: Map<string, WebhookWorkerState>
  lifecycleLocks: Map<string, Promise<void>>
  lifecycleEpochs: Map<string, bigint>
  lifecycleCounter: bigint
  pollLeases: Map<string, { timer: ReturnType<typeof setTimeout>; definition: McpEventDefinition }>
}

const EVENT_RUNTIME_STATES = new WeakMap<
  AnyElysiaApp,
  WeakMap<NormalizedMcpPluginOptions, EventRuntimeState>
>()

export function eventRuntimeState(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): EventRuntimeState {
  let byOptions = EVENT_RUNTIME_STATES.get(app)
  if (!byOptions) {
    byOptions = new WeakMap()
    EVENT_RUNTIME_STATES.set(app, byOptions)
  }
  let state = byOptions.get(options)
  if (!state) {
    state = createEventRuntimeState()
    byOptions.set(options, state)
  }
  return state
}

function createEventRuntimeState(): EventRuntimeState {
  return {
    workers: new Map(),
    lifecycleLocks: new Map(),
    lifecycleEpochs: new Map(),
    lifecycleCounter: 0n,
    pollLeases: new Map()
  }
}

export function webhookWorkers(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): Map<string, WebhookWorkerState> {
  return eventRuntimeState(app, options).workers
}

export async function withWebhookLifecycleLock<T>(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  id: string,
  operation: () => Promise<T>
): Promise<T> {
  const locks = eventRuntimeState(app, options).lifecycleLocks
  const previous = locks.get(id) ?? Promise.resolve()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => {}).then(() => gate)
  locks.set(id, tail)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(id) === tail) locks.delete(id)
  }
}

export function nextWebhookLifecycleEpoch(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  id: string
): bigint {
  const state = eventRuntimeState(app, options)
  const epoch = state.lifecycleCounter + 1n
  state.lifecycleCounter = epoch
  state.lifecycleEpochs.set(id, epoch)
  return epoch
}

export function webhookLifecycleEpoch(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  id: string
): bigint {
  return eventRuntimeState(app, options).lifecycleEpochs.get(id) ?? 0n
}

export function retireWebhookLifecycleEpoch(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  id: string,
  epoch: bigint
): void {
  const state = eventRuntimeState(app, options)
  if (state.lifecycleEpochs.get(id) !== epoch || state.workers.has(id)) return
  state.lifecycleEpochs.delete(id)
}
