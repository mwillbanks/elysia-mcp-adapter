<p align="center">
  <img src="./logo.svg" alt="Elysia MCP Adapter logo" width="164" />
</p>

<h1 align="center">Elysia MCP Adapter</h1>

<p align="center">
  Expose Elysia routes and MCP-native primitives through one secure Model Context Protocol endpoint.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mwillbanks/elysia-mcp-adapter"><img alt="npm" src="https://img.shields.io/npm/v/@mwillbanks/elysia-mcp-adapter?style=flat-square&color=8b5cf6" /></a>
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-ec4899?style=flat-square" /></a>
  <a href="https://mwillbanks.github.io/elysia-mcp-adapter/"><img alt="Documentation" src="https://img.shields.io/badge/docs-live-06b6d4?style=flat-square" /></a>
</p>

`@mwillbanks/elysia-mcp-adapter` turns eligible Elysia HTTP routes into MCP tools while preserving the request lifecycle you already rely on: parsing, validation, hooks, guards, authentication, error handling, and response mapping. It also provides thin APIs for standalone tools, resources, resource templates, and prompts.

## Why this adapter?

- **Keep Elysia in charge.** Route-backed calls run through `app.handle(new Request(...))`; handlers are never invoked out of band.
- **Reuse schemas.** Existing TypeBox and route schemas are normalized to JSON Schema for MCP clients.
- **Secure by default.** Origin checks are enabled, model-controlled headers are denied, credential-bearing response headers are redacted, and binary responses are disabled.
- **Stay protocol-focused.** The package is ESM-only and does not introduce a second application framework or translate TypeBox to Zod.

## Install

```bash
bun add @mwillbanks/elysia-mcp-adapter elysia
```

Node.js `>=20.11`, Bun `>=1.1`, Elysia `>=1.4`, and TypeScript `>=5.8` are supported.

## Quick start

```ts
import { mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia, t } from 'elysia'

const app = new Elysia()
  .use(
    mcp({
      server: {
        name: 'users-api',
        version: '1.0.0'
      }
    })
  )
  .get(
    '/users/:id',
    ({ params }) => ({ id: params.id }),
    {
      params: t.Object({ id: t.String() }),
      detail: {
        operationId: 'users.get',
        summary: 'Get a user'
      }
    }
  )
  .listen(3000)
```

The adapter exposes `GET /users/:id` as the `users.get` MCP tool at `POST /mcp`. The default protocol is `2026-07-28`. Modern clients send the required protocol, method, target, and Accept headers. Tool calls are converted to internal HTTP requests and sent back through Elysia:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "users.get",
    "arguments": {
      "params": { "id": "user_123" }
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "example-client", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

## Explicit MCP primitives

Install the plugin, then register MCP-only behavior alongside your HTTP routes:

```ts
const app = new Elysia()
  .use(mcp({ allowedRoutes: [] }))
  .mcpTool(
    'math.add',
    ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
    {
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' }
        },
        required: ['a', 'b'],
        additionalProperties: false
      }
    }
  )
  .mcpResource('config://runtime', () => ({ environment: 'production' }))
  .mcpPrompt(
    'review-error',
    ({ message }: { message: string }) => `Review this error: ${message}`
  )
```

Routes become tools by default. Resources and prompts require explicit route metadata or the standalone methods above.

## MCP extensions

Tasks, OAuth resource-server enforcement, enterprise authorization profiles, Apps, and Skills are opt-in:

```ts
app.use(
  mcp({
    transport: {
      protocolVersions: ['2026-07-28', '2025-11-25']
    },
    extensions: {
      tasks: {
        version: 'current',
        provider
      },
      auth: {
        version: 'current',
        resource: 'https://api.example.com/mcp',
        authorizationServers: ['https://auth.example.com'],
        verifyAccessToken
      },
      apps: {
        version: 'current'
      },
      skills: {
        version: 'current',
        directoryRead: true
      }
    }
  })
)
```

Omitting an extension version selects `current`; supported dated and draft selectors resolve through the exported `MCP_EXTENSION_SUPPORT` manifest. Tasks keeps `draft` pinned to revision `2c1425d` and exposes the current draft as `draft-5246bc3`, so updating upstream does not move the legacy codec. Modern MCP `2026-07-28` uses per-request protocol metadata and `server/discover`, while legacy `2025-11-25` initialization remains supported. Tasks require modern MCP and a durable provider.

### Modern core behavior

The `core` option configures published `2026-07-28` utilities:

```ts
mcp({
  core: {
    continuation: { signingKey: process.env.MCP_CONTINUATION_KEY! },
    pagination: { pageSize: 100, signingKey: process.env.MCP_CURSOR_KEY! },
    cache: { default: { cacheScope: 'private', ttlMs: 0 } },
    subscriptions: { provider, toolsListChanged: true, resources: true }
  }
})
```

Tools, resource reads, and prompts can return `McpInputRequiredResult`. Invocation contexts expose validated `inputResponses`, restored `requestState`, client metadata, an abort signal, and `reportProgress()`. Route handlers read the same request-scoped values with `getMcpInvocationContext(request)`. Prompt and resource-template registrations accept completion callbacks. Pagination and subscriptions remain disabled until configured. Signing keys must contain at least 32 bytes. Single-use continuations require an application provider.

Unversioned requests select the modern default and must include its complete envelope. Send `MCP-Protocol-Version: 2025-11-25`, or configure `protocolVersions: ['2025-11-25']`, for legacy clients. Hosts approve and fulfill elicitation, sampling, and roots requests before retrying the original operation.

The exported `MCP_EXTENSION_LATEST_REVIEWED` manifest records reviewed upstream sources for planning. It does not advertise adapter support.

The repository includes tested, package-root examples for every extension:

- [Tasks](./examples/tasks/) uses SQLite subprocess workers and BullMQ 6 with real Redis.
- [Authorization](./examples/auth/) uses Better Auth, Bun SQLite, OAuth Provider, and SAML SSO.
- [Apps vanilla](./examples/apps-vanilla/) and [Apps React](./examples/apps-react/) use the MCP Apps v2 SDK and build one self-contained HTML document with Bun.
- [Modern core](./examples/core/) includes a minimal client for MRTR, completion, pagination, progress, cancellation, and subscriptions.
- [Skills](./examples/skills/) registers exact skill bytes and verifies paginated manifests, direct lookup, and resource integrity.
- [Experimental extensions](./examples/experimental/) exercises server cards, interceptors, server variants, resource subscriptions, action metadata, and trust annotations.
- [Events](./examples/events/) demonstrates replay polling, event-only SSE, durable Bun SQLite subscriptions, and verified webhooks.

### Experimental extension policy

Experimental extensions are off by default. Enable each feature explicitly and pin its exported revision constant. Revision selectors are immutable reviewed commits, not semver ranges. Server variants require legacy `2025-11-25`; modern protocol configuration rejects them. Other experiments use modern transport methods where the draft defines them.

Server cards publish advisory discovery metadata at `GET /mcp/server-card`. They use `application/mcp-server-card+json`, CORS, ETags, and conditional caching. Use HTTPS in production. Loopback HTTP is development-only. Cards must not contain credentials, private topology, or primitive catalogs. Clients decide whether and when to fetch them.

Interceptors expose canonical `interceptors/list` and singular `interceptor/invoke`. Pass `sending` to `executeInterceptorChain()` to mutate before validation. Pass `receiving` to validate before mutation. Validators run in parallel against isolated payload clones. Mutators run sequentially and use the phase-specific `priorityHint`, then name ordering for ties. Only `severity: 'error'` blocks. Audit mode never blocks and returns completed or failed outcomes for observability. Failures close by default; `failOpen` is explicit, and timeouts abort the local handler. Every wire result includes its interceptor, type, and phase. The adapter never contacts external interceptor services.

Legacy server variants bind discovery, selection, cursors, registries, subscriptions, and requests to the authenticated `MCP-Session-Id`. Metadata key `io.modelcontextprotocol/server-variant` takes precedence over `MCP-Server-Variant`. The first visible, ranked variant must be stable unless the client requests experimental results. Unsubscribe and session deletion close subscription iterators.

Action metadata describes destinations, sources, sensitivity, outcome, and review needs. Trust result metadata distinguishes an absent boolean from `false`. Evidence references are bounded descriptors; the adapter does not fetch them. Hosts own approval, union-strengthening, consent, evidence retrieval, and unavailable functionality. Behavioral annotations never grant authorization.

Events are legacy-only and pinned to revision `6682596d65eec778fe0b8b1f43b4e89d2fe2c546`. The adapter supports authorized discovery, replay polling, event-only SSE, and durable webhook subscriptions. Clients own replay cursors. Webhook providers atomically preserve ownership, verification, secrets, expiry, and status, then reauthorize every delivery. The runnable example performs real signed TLS subscription, rotation, restart recovery, and unsubscribe operations through the adapter.

Client support changes independently of this package. Consult the canonical [MCP Extension Support Matrix](https://modelcontextprotocol.io/extensions/client-matrix).

## Documentation

The full guides and API reference live at **[mwillbanks.github.io/elysia-mcp-adapter](https://mwillbanks.github.io/elysia-mcp-adapter/)**:

- [Installation and quick start](https://mwillbanks.github.io/elysia-mcp-adapter/docs/getting-started/quick-start/)
- [Route-backed tools](https://mwillbanks.github.io/elysia-mcp-adapter/docs/core-concepts/route-backed-tools/)
- [Resources and prompts](https://mwillbanks.github.io/elysia-mcp-adapter/docs/core-concepts/resources-and-prompts/)
- [Configuration reference](https://mwillbanks.github.io/elysia-mcp-adapter/docs/getting-started/configuration/)
- [Security model](https://mwillbanks.github.io/elysia-mcp-adapter/docs/core-concepts/security/)
- [MCP extensions](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/)
- [MCP specification inventory](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/specification-inventory/)
- [Tasks guide](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/tasks/)
- [Authorization guide](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/authorization/)
- [Apps guide](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/apps/)
- [Skills guide](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/skills/)

## Development

```bash
bun link
bun install
bun run lint
bun run typecheck
bun test
bun run fallow
bun run build
```

Documentation development runs independently from `website/` with `bun install` and `bun run dev`.

## License

[MIT](./LICENSE) © Mike Willbanks
