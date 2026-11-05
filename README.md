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

## Agent guidance

The npm package includes an Agent Skill for integrating the adapter. Install TanStack Intent as
a local development dependency in the consuming project. Intent 0.5.6 requires Node.js 20.12
or later.

```bash
bun add --dev --exact @tanstack/intent@0.5.6
```

Set an explicit allowlist in the consuming project's `package.json`:

```json
{
  "intent": {
    "skills": ["@mwillbanks/elysia-mcp-adapter#elysia-mcp-adapter"],
    "exclude": []
  }
}
```

Use exact `package#skill` entries. Every dependency needs its own permission.
Exclusions override permissions. To revoke a skill, remove its entry or add its
exact reference to `intent.exclude`. Use `"skills": []` to disable all sources.

Run the installed CLI from the consuming project:

```bash
./node_modules/.bin/intent list
./node_modules/.bin/intent load '@mwillbanks/elysia-mcp-adapter#elysia-mcp-adapter'
```

Load the matching skill only when it applies to the current task. Open the reference
for that task. Use a project-local `node_modules` install for file-only discovery.
Intent reads installed package metadata and guidance without running dependency code.
When Yarn Plug'n'Play has no usable `node_modules`, Intent loads Yarn's `.pnp.cjs` resolver
to locate the files. Editor hooks are optional convenience. Keep the trust policy in
`package.json` and review guidance when dependencies change.

See the [Intent trust model](https://tanstack.com/intent/latest/docs/concepts/trust-model).

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
  .get('/users/:id', ({ params }) => ({ id: params.id }), {
    params: t.Object({ id: t.String() }),
    detail: {
      operationId: 'users.get',
      summary: 'Get a user'
    }
  })
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
  .mcpTool('math.add', ({ a, b }: { a: number; b: number }) => ({ sum: a + b }), {
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' }
      },
      required: ['a', 'b'],
      additionalProperties: false
    }
  })
  .mcpResource('config://runtime', () => ({ environment: 'production' }))
  .mcpPrompt('review-error', ({ message }: { message: string }) => `Review this error: ${message}`)
```

Routes become tools by default. Resources and prompts require explicit route metadata or the standalone methods above. Add a `prompt` option to an explicit or route-backed tool to register an associated prompt that guides the host to call that tool; use `.mcpPrompt()` for standalone prompts.

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

Omitting an extension version selects `current`; supported dated and draft selectors resolve through the exported `MCP_EXTENSION_SUPPORT` manifest. Tasks provides the approved `current` revision and the explicit draft `draft-b3d28ac`. Update retired draft selectors using the migration guidance in the configuration error. Modern MCP `2026-07-28` uses per-request protocol metadata and `server/discover`, while legacy `2025-11-25` initialization remains supported. Tasks require modern MCP and a durable provider.

Workers can create a `McpTaskExecutionContext` with `createMcpTaskExecutionContext(options)`. Pass `McpTaskExecutionContextOptions` with the task ID, the original provider context, and the provider's persistence callbacks. Use `execution.notify.status()` for updates and `execution.input.request()` for client input. Rebuild the context from durable data after a restart. See the [Tasks worker example](./examples/tasks/) for the full flow.

See the [specification inventory](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/specification-inventory/) for exact revisions and draft compatibility.
Configure [specification notices](https://mwillbanks.github.io/elysia-mcp-adapter/docs/core-concepts/specification-notices/) to receive deprecation and pre-release notices in application logs or through your OpenTelemetry Logs provider.

### Modern core behavior

The `core` option configures published `2026-07-28` utilities:

```ts
mcp({
  core: {
    maxToolInputElements: 10_000,
    continuation: { signingKey: process.env.MCP_CONTINUATION_KEY! },
    pagination: { pageSize: 100, signingKey: process.env.MCP_CURSOR_KEY! },
    cache: { default: { cacheScope: 'private', ttlMs: 0 } },
    subscriptions: { provider, toolsListChanged: true, resources: true }
  }
})
```

Tools, resource reads, and prompts can return `McpInputRequiredResult`. Invocation contexts expose `notify.progress()`, opt-in `notify.message()`, and typed `input` helpers alongside the existing `reportProgress()`, `inputResponses`, and `requestState` APIs. Route handlers read the same request-scoped values with `getMcpInvocationContext(request)`. Prompt and resource-template registrations accept completion callbacks. Pagination and subscriptions remain disabled until configured. Signing keys must contain at least 32 bytes. Single-use continuations require an application provider.

Use [request language preferences](https://mwillbanks.github.io/elysia-mcp-adapter/docs/core-concepts/language-preference/) to provide localized display text from your application.

See the [messaging guide](https://mwillbanks.github.io/elysia-mcp-adapter/docs/core-concepts/messaging/) for live and durable updates, input, subscriptions, and tool-linked prompts. Set `prompt` on a tool to add a companion prompt without duplicating its registration.

`core.maxToolInputElements` optionally rejects oversized nested tool inputs before route handlers or task providers run. It counts object members and array elements and leaves input unlimited when omitted. `transport.allowedOrigins` accepts exact serialized origins and explicit non-HTTP scheme patterns such as `chrome-extension://*`. HTTP, HTTPS, and global wildcards remain forbidden.

The MCP client SDK `2.4.0` interoperates with modern discovery, progress SSE, prompts, and task reads
and cancellation. It rejects valid task-creation responses after creating the task because its decoder
does not accept `resultType: 'task'`. Use the minimal Tasks clients for creation and avoid blind retries.

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

### Server Cards

Server Cards are a finalized MCP extension. They publish advisory discovery metadata at `GET /mcp/server-card`. They use `application/mcp-server-card+json`, CORS, ETags, and conditional caching. Use HTTPS in production. Loopback HTTP is development-only. Cards must not contain credentials, private topology, or primitive catalogs. Clients decide whether and when to fetch them.

`MCP_EXTENSION_SUPPORT` reports Beta maturity for Tasks, Skills over MCP, and Server Cards. The approved Server Cards wire baseline still reports `status: 'stable'` under Final SEP-2127.

### Experimental extension policy

Experimental extensions are off by default. Enable each feature explicitly and pin its exported revision constant. Revision selectors are immutable reviewed commits, not semver ranges. Server variants require legacy `2025-11-25`; modern protocol configuration rejects them. Other experiments use modern transport methods where the draft defines them.

Interceptors expose canonical `interceptors/list` and singular `interceptor/invoke`. Pass `sending` to `executeInterceptorChain()` to mutate before validation. Pass `receiving` to validate before mutation. Validators run in parallel against isolated payload clones. Mutators run sequentially and use the phase-specific `priorityHint`, then name ordering for ties. Only `severity: 'error'` blocks. Audit mode never blocks and returns completed or failed outcomes for observability. Failures close by default; `failOpen` is explicit, and timeouts abort the local handler. Every wire result includes its interceptor, type, and phase. The adapter never contacts external interceptor services.

Legacy server variants bind discovery, selection, cursors, registries, subscriptions, and requests to the authenticated `MCP-Session-Id`. Metadata key `io.modelcontextprotocol/server-variant` takes precedence over `MCP-Server-Variant`. The first visible, ranked variant must be stable unless the client requests experimental results. Unsubscribe and session deletion close subscription iterators.

Action metadata describes destinations, sources, sensitivity, outcome, and review needs. Trust result metadata distinguishes an absent boolean from `false`. Evidence references are bounded descriptors; the adapter does not fetch them. Hosts own approval, union-strengthening, consent, evidence retrieval, and unavailable functionality. Behavioral annotations never grant authorization.

Events require MCP `2026-07-28` and default to [the Triggers & Events Working Group draft](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/b08e4f9dd684f39d846d94089487fbeb28e666f5/seps/0000-events-extension.md). The adapter supports authorized discovery, replay polling, event-only SSE, and durable webhook subscriptions. Clients own replay cursors. Webhook providers atomically preserve ownership, verification, secrets, expiry, and status, then reauthorize every delivery. The runnable example performs real signed TLS subscription, rotation, restart recovery, and unsubscribe operations through the adapter.

Client support changes independently of this package. Consult the canonical [MCP Extension Support Matrix](https://modelcontextprotocol.io/extensions/client-matrix).

The experimental Filesystems repository currently defines no wire contract. The adapter exposes no filesystem methods and monitors its pinned README for future normative changes.

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
- [Structured authorization denials](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/authorization/structured-denials/) explains the opt-in SEP-2643 tool policy and remediation.
- [Apps guide](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/apps/)
- [Skills guide](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/skills/)

## Development

```bash
bun link
bun install
bun install --cwd website
bun run lint
bun run typecheck
bun --bun run --cwd website typecheck
bun test
bun test --coverage --coverage-reporter=lcov
bun run fallow
bun run build
```

Documentation development runs independently from `website/` with `bun install` and `bun run dev`.

`bun run fallow` checks dependencies, duplication, and health for the adapter and website independently.
Every finding fails the gate under the default thresholds. CI records measured Bun coverage separately
from Fallow's estimated coverage. Installation, builds, tests, and packed-consumer checks use Bun;
the declared Node.js compatibility floor is checked statically.

## Extension revisions and toolchain

Use Bun 1.4.4. `bun run lint` checks formatting with `bun fmt`; `bun run typecheck`
uses `bun check`. Fallow remains the static analysis gate. No standalone lint package is required.

Skills preserves optional JSON `_meta` on registrations and provider sources. Extension-owned keys
use `io.modelcontextprotocol.skills/`. Resource digests still cover exact published bytes.
Interceptors use the current `07c89a24` proposal, including timestamped invocation context,
optional span/session identifiers, and per-call configuration validation. See the separate HTTP
service in `examples/experimental`; local chain helpers remain local utilities.
Events uses draft `b08e4f9d` and codes `-32023` through `-32027`. Migrate older Events pins to `current` and discover Events on `server/discover`. Server Variants still uses legacy transport.

Apps, Client Credentials, and Enterprise-Managed Authorization have approved profiles.
Server Cards follows Final SEP-2127. Tasks exposes approved and pinned draft selections.
File Uploads and Filesystems have no defined wire contract: they are inventoried, not implemented.
See the website specification inventory for immutable sources, hashes, limitations, and all selectors.

## License

[MIT](./LICENSE) © Mike Willbanks
