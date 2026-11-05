import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import {
  assertServerCard,
  MCP_SERVER_CARD_DRAFT_REVISION,
  MCP_SERVER_CARD_SCHEMA,
  type McpServerCardExtensionInfo,
  mcp
} from '../src/index.js'

const endpoint = 'http://localhost/mcp/server-card'
const events = 'io.modelcontextprotocol/events'
const publicKey = {
  kty: 'OKP',
  crv: 'Ed25519',
  kid: '2026-10',
  x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'
}

function cardWith(extensions: unknown) {
  return {
    $schema: MCP_SERVER_CARD_SCHEMA,
    name: 'example-org/with-extensions',
    description: 'Public MCP metadata',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', extensions }]
  }
}

describe('Server Card remote extension draft', () => {
  test('serves public draft metadata only after selecting the exact revision', async () => {
    const extensions = {
      [events]: {
        webhooks: { signingKeys: { keys: [publicKey] } },
        numbers: [1, 2],
        enabled: true
      }
    } satisfies Record<string, McpServerCardExtensionInfo>
    const card = {
      ...cardWith(extensions),
      remotes: [
        { type: 'streamable-http' as const, url: 'https://mcp.example.com/mcp', extensions }
      ]
    }
    expect(() => assertServerCard(card, 'production')).toThrow('explicit draft revision')
    const app = new Elysia().use(
      mcp({
        extensions: { serverCard: { version: MCP_SERVER_CARD_DRAFT_REVISION, card } }
      })
    )
    const response = await app.handle(new Request(endpoint))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(card)
  })

  test.each([
    { extensions: true, error: 'extensions must be an object' },
    { extensions: { events: {} }, error: 'identifiers require a prefix' },
    { extensions: { [events]: false }, error: 'information must be an object' },
    { extensions: { [events]: { nested: [null] } }, error: 'pinned JSON value schema' },
    { extensions: { [events]: { fraction: 1.25 } }, error: 'pinned JSON value schema' },
    { extensions: { [events]: { key: { ...publicKey, d: 'private' } } }, error: 'private key' },
    { extensions: { [events]: { key: { kty: 'oct', k: 'private' } } }, error: 'private key' },
    { extensions: { [events]: { key: { d: 'private' } } }, error: 'private key' },
    { extensions: { [events]: { key: { k: 'private' } } }, error: 'private key' },
    { extensions: { [events]: { secret: 'private' } }, error: 'credentials or tokens' }
  ])('rejects draft metadata with $error', ({ extensions, error }) => {
    expect(() =>
      assertServerCard(cardWith(extensions), 'production', MCP_SERVER_CARD_DRAFT_REVISION)
    ).toThrow(error)
  })

  test('rejects cyclic metadata before serializing a public response', () => {
    const data: Record<string, unknown> = {}
    data.self = data
    expect(() =>
      assertServerCard(cardWith({ [events]: data }), 'production', MCP_SERVER_CARD_DRAFT_REVISION)
    ).toThrow('must be acyclic')
  })
})
