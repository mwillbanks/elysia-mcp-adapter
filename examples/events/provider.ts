import { Database } from 'bun:sqlite'
import type {
  McpAuthorizationContext,
  McpWebhookSubscriptionProvider,
  McpWebhookSubscriptionRecord
} from '@mwillbanks/elysia-mcp-adapter'

export class SqliteWebhookProvider implements McpWebhookSubscriptionProvider {
  readonly durability = 'durable' as const
  readonly #database: Database
  readonly #authorize: (principal: string) => McpAuthorizationContext | false

  constructor(path: string, authorize: (principal: string) => McpAuthorizationContext | false) {
    this.#database = new Database(path, { create: true })
    this.#authorize = authorize
    this.#database.exec('PRAGMA busy_timeout = 1000')
    const journal = this.#database.query('PRAGMA journal_mode').get() as { journal_mode: string }
    if (journal.journal_mode.toLowerCase() !== 'wal')
      this.#database.exec('PRAGMA journal_mode = WAL')
    this.#database.exec(`CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        key TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        record TEXT NOT NULL
      )`)
    this.#database.exec(
      'CREATE INDEX IF NOT EXISTS webhook_owner ON webhook_subscriptions(principal)'
    )
  }

  get(key: string): McpWebhookSubscriptionRecord | null {
    const row = this.#database
      .query('SELECT record FROM webhook_subscriptions WHERE key = ?')
      .get(key) as { record: string } | null
    return row ? JSON.parse(row.record) : null
  }

  upsert(record: McpWebhookSubscriptionRecord, options: { maxSubscriptionsPerPrincipal: number }) {
    return this.#database
      .transaction(() => {
        const existing = this.get(record.key)
        if (existing && existing.principal !== record.principal)
          throw new TypeError('Webhook subscription ownership cannot change')
        const count = this.#database
          .query('SELECT count(*) AS count FROM webhook_subscriptions WHERE principal = ?')
          .get(record.principal) as { count: number }
        if (!existing && count.count >= options.maxSubscriptionsPerPrincipal)
          return { limitExceeded: true } as const
        this.#database
          .query(`INSERT INTO webhook_subscriptions(key, principal, record) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET principal = excluded.principal, record = excluded.record`)
          .run(record.key, record.principal, JSON.stringify(record))
        return { record: structuredClone(record), created: !existing }
      })
      .immediate()
  }

  delete(key: string): boolean {
    return (
      this.#database.query('DELETE FROM webhook_subscriptions WHERE key = ?').run(key).changes > 0
    )
  }

  async *list(): AsyncIterable<McpWebhookSubscriptionRecord> {
    for (const row of this.#database
      .query('SELECT record FROM webhook_subscriptions ORDER BY key')
      .all() as Array<{ record: string }>)
      yield JSON.parse(row.record)
  }

  authorizeDelivery(record: Readonly<McpWebhookSubscriptionRecord>) {
    return this.#authorize(record.principal)
  }

  close() {
    this.#database.close()
  }
}
