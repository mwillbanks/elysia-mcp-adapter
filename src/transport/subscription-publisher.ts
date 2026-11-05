import type {
  McpServerNotification,
  McpSubscriptionFilter,
  McpSubscriptionProvider
} from '../types.js'

export interface McpSubscriptionPublisherOptions {
  /** Maximum distinct queued notifications per subscriber. */
  maxPending?: number
  /** Maximum number of live subscriptions served by this publisher. */
  maxSubscribers?: number
}

export interface McpSubscriptionPublisher {
  provider: McpSubscriptionProvider
  toolsListChanged(): void
  promptsListChanged(): void
  resourcesListChanged(): void
  resourceUpdated(uri: string): void
}

const LIST_FILTERS = {
  'notifications/tools/list_changed': 'toolsListChanged',
  'notifications/prompts/list_changed': 'promptsListChanged',
  'notifications/resources/list_changed': 'resourcesListChanged'
} as const

type LocalNotification = Extract<
  McpServerNotification,
  { method: keyof typeof LIST_FILTERS | 'notifications/resources/updated' }
>

type Subscriber = (notification: LocalNotification) => void

/**
 * Create a process-local publisher and its subscription provider. Slow subscribers
 * that exhaust the queue must reconnect and refresh their view.
 */
export function createMcpSubscriptionPublisher(
  options: McpSubscriptionPublisherOptions = {}
): McpSubscriptionPublisher {
  const maxPending = positiveLimit(options.maxPending ?? 128, 'maxPending')
  const maxSubscribers = positiveLimit(options.maxSubscribers ?? 1024, 'maxSubscribers')
  const subscribers = new Set<Subscriber>()
  const publish = (notification: LocalNotification) => {
    for (const receive of subscribers) receive(notification)
  }

  return {
    provider: {
      subscribe(filter, context, authorizeResourceUpdate) {
        if (subscribers.size >= maxSubscribers && !context.signal?.aborted) {
          throw new Error('MCP subscription publisher capacity exceeded')
        }
        return localSubscription(
          subscribers,
          filter,
          context.signal,
          maxPending,
          authorizeResourceUpdate
        )
      }
    },
    toolsListChanged: () => publish(Object.freeze({ method: 'notifications/tools/list_changed' })),
    promptsListChanged: () =>
      publish(Object.freeze({ method: 'notifications/prompts/list_changed' })),
    resourcesListChanged: () =>
      publish(Object.freeze({ method: 'notifications/resources/list_changed' })),
    resourceUpdated(uri) {
      if (typeof uri !== 'string' || uri.length === 0)
        throw new TypeError('Resource URI is required')
      publish(
        Object.freeze({
          method: 'notifications/resources/updated',
          params: Object.freeze({ uri })
        })
      )
    }
  }
}

function localSubscription(
  subscribers: Set<Subscriber>,
  filter: Readonly<McpSubscriptionFilter>,
  signal: AbortSignal | undefined,
  maxPending: number,
  authorizeResourceUpdate?: (uri: string) => boolean
): AsyncIterableIterator<McpServerNotification> {
  const pending = new Map<string, LocalNotification>()
  const resources = [...(filter.resourceSubscriptions ?? [])]
  const done = { done: true, value: undefined } as const
  let waiting: ((result: IteratorResult<LocalNotification>) => void) | undefined
  let overflow = false
  let closed = false

  function close() {
    closed = true
    subscribers.delete(receive)
    signal?.removeEventListener('abort', close)
    pending.clear()
    waiting?.(done)
    waiting = undefined
  }

  function receive(notification: LocalNotification) {
    let key: string = notification.method
    if (notification.method === 'notifications/resources/updated') {
      const { uri } = notification.params
      if (!resources.some((subscribed) => isSameOrDescendantUri(subscribed, uri))) return
      if (authorizeResourceUpdate && !authorizeResourceUpdate(uri)) return
      key += ':' + uri
    } else if (!filter[LIST_FILTERS[notification.method]]) {
      return
    }
    if (waiting) {
      const resolve = waiting
      waiting = undefined
      resolve({ done: false, value: notification })
      return
    }
    if (pending.has(key)) return
    if (pending.size >= maxPending) {
      overflow = true
      close()
      return
    }
    pending.set(key, notification)
  }

  if (signal?.aborted) close()
  else {
    subscribers.add(receive)
    signal?.addEventListener('abort', close, { once: true })
  }

  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (overflow) {
        overflow = false
        throw new Error('MCP subscription publisher queue exceeded')
      }
      if (closed) return done
      const first = pending.entries().next()
      if (!first.done) {
        const [key, value] = first.value
        pending.delete(key)
        return { done: false, value }
      }
      if (waiting) throw new Error('MCP subscription provider requires sequential reads')
      return new Promise<IteratorResult<LocalNotification>>((resolve) => {
        waiting = resolve
      })
    },
    async return() {
      overflow = false
      close()
      return done
    }
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(name + ' must be a positive safe integer')
  }
  return value
}

export function isSameOrDescendantUri(subscribedUri: string, updatedUri: string): boolean {
  if (subscribedUri === updatedUri) return true
  const subscribed = parseUrl(subscribedUri)
  const updated = parseUrl(updatedUri)
  if (!subscribed || !updated || urlAuthority(subscribed) !== urlAuthority(updated)) return false
  const basePath = subscribed.pathname.endsWith('/')
    ? subscribed.pathname
    : subscribed.pathname + '/'
  return updated.pathname.startsWith(basePath)
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function urlAuthority(url: URL): string {
  return JSON.stringify([url.protocol, url.username, url.password, url.host, url.search, url.hash])
}
