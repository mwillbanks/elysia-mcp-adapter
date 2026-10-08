import type { McpEventHandler, McpEventOccurrence } from '@mwillbanks/elysia-mcp-adapter'

interface StoredEvent extends McpEventOccurrence {
  sequence: number
  project?: string
}

export class InMemoryEventHistory {
  readonly epoch = crypto.randomUUID()
  readonly #maxEntries: number
  readonly #now: () => number
  readonly #events: StoredEvent[] = []
  #sequence = 0
  #evictedThrough = 0

  constructor(maxEntries = 100, now: () => number = Date.now) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0)
      throw new TypeError('History maxEntries must be a positive integer')
    this.#maxEntries = maxEntries
    this.#now = now
  }

  publish(name: string, data: Record<string, unknown>, project?: string): McpEventOccurrence {
    this.#sequence += 1
    const cursor = this.#cursor(this.#sequence)
    const event: StoredEvent = {
      eventId: `event-${this.epoch}-${this.#sequence}`,
      name,
      timestamp: new Date(this.#now()).toISOString(),
      data: structuredClone(data),
      cursor,
      sequence: this.#sequence,
      project
    }
    this.#events.push(event)
    while (this.#events.length > this.#maxEntries) {
      const removed = this.#events.shift()
      if (removed) this.#evictedThrough = removed.sequence
    }
    return this.#public(event)
  }

  handler(nextPollMs: number): McpEventHandler {
    return ({ cursor, arguments: arguments_, maxAgeMs, maxEvents }) => {
      if (cursor === null) return { events: [], cursor: this.#cursor(this.#sequence), nextPollMs }
      const position = this.#parse(cursor)
      if (!position || position.epoch !== this.epoch || position.sequence < this.#evictedThrough)
        return {
          events: [],
          cursor: this.#cursor(this.#sequence),
          truncated: true,
          hasMore: false,
          nextPollMs
        }
      const project = typeof arguments_.project === 'string' ? arguments_.project : undefined
      const cutoff = maxAgeMs === undefined ? undefined : this.#now() - maxAgeMs
      const expired = this.#events.some(
        (event) =>
          event.sequence > position.sequence &&
          (project === undefined || event.project === project) &&
          cutoff !== undefined &&
          Date.parse(event.timestamp) < cutoff
      )
      const eligible = this.#events.filter(
        (event) =>
          event.sequence > position.sequence &&
          (project === undefined || event.project === project) &&
          (cutoff === undefined || Date.parse(event.timestamp) >= cutoff)
      )
      const events = eligible.slice(0, maxEvents).map((event) => this.#public(event))
      const last = events.at(-1)?.cursor ?? cursor
      return {
        events,
        cursor: last,
        truncated: expired,
        hasMore: eligible.length > events.length,
        nextPollMs
      }
    }
  }

  #cursor(sequence: number) {
    return `${this.epoch}:${sequence}`
  }

  #parse(cursor: string) {
    const separator = cursor.lastIndexOf(':')
    if (separator <= 0) return null
    const epoch = cursor.slice(0, separator)
    const sequence = Number(cursor.slice(separator + 1))
    return Number.isSafeInteger(sequence) && sequence >= 0 ? { epoch, sequence } : null
  }

  #public(event: StoredEvent): McpEventOccurrence {
    const { sequence: _sequence, project: _project, ...publicEvent } = event
    return structuredClone(publicEvent)
  }
}
