# AGENTS.md

This repository contains `@mwillbanks/elysia-mcp-adapter`, an Elysia plugin that exposes Elysia HTTP routes and standalone MCP primitives through a Model Context Protocol HTTP endpoint.

## Operating principles

- Treat the adapter as production infrastructure.
- Preserve Elysia semantics. Route-backed MCP calls must invoke `app.handle(new Request(...))` rather than calling route handlers directly.
- Avoid introducing a second application framework inside the plugin.
- Keep MCP-specific abstractions thin and protocol-oriented.
- Prefer explicit opt-in for resources and prompts. HTTP routes become tools by default.
- Avoid model-controlled access to headers, cookies, credentials, or filesystem data unless explicitly configured.
- Keep route discovery isolated in `src/route-inspector.ts` because Elysia internals may change.

## Development workflow

This project uses Bun as its package manager and test runner. Run these checks before
considering a change complete:

```bash
bun run lint       # biome (formatting + lint)
bun run typecheck  # tsc --noEmit
bun test           # bun:test suites in test/
bun run fallow     # dead code + duplication gate
bun run build      # tsup ESM + d.ts output
```

Commits are validated by husky: `commit-msg` runs commitlint (Conventional Commits) and
`pre-commit` runs Biome on staged files. Releases are automated by release-please
(`.github/workflows/release.yml`) from Conventional Commit history.

## Source map

- `src/plugin.ts`: Elysia plugin entrypoint and macro registration.
- `src/methods/install.ts`: Runtime installation of `.mcpTool()`, `.mcpResource()`, and `.mcpPrompt()`.
- `src/registry.ts`: Registry builder for explicit and route-backed tools/resources/prompts.
- `src/route-inspector.ts`: Elysia route discovery adapter.
- `src/route-filters.ts`: `allowedRoutes` / `excludedRoutes` behavior.
- `src/schema/*`: JSON Schema normalization, composition, and validation.
- `src/invoke/*`: Internal Elysia request construction and response marshaling.
- `src/transport/json-rpc.ts`: MCP JSON-RPC over HTTP transport.

## Compatibility targets

- Node.js `>=20.11`.
- Elysia `>=1.4.0`.
- TypeScript `>=5.8`.
- Native ESM package output.

## Design constraints

### Route-backed tools

Route-backed tools must preserve:

- Elysia validation.
- Elysia parsing.
- Local hooks.
- Guards.
- Auth plugins.
- Error handling.
- Response mapping.

Do not bypass those layers by invoking the route handler directly.

### Schema handling

- Keep the registry schema format as JSON Schema.
- Do not translate TypeBox to Zod.
- Sanitize TypeBox runtime symbols/functions when exposing MCP schemas.
- Let route-level `mcp.inputSchema` and `mcp.outputSchema` override inferred route schemas.

### Security

- Keep `Origin` validation default-enabled.
- Keep model-controlled headers default-denied.
- Redact credential-bearing response headers.
- Keep binary output disabled unless explicitly enabled.
- Avoid silently exposing hidden/docs/admin routes.

## Release checklist

- Update `README.md` when changing public APIs.
- Keep package name as `@mwillbanks/elysia-mcp-adapter`.
- Keep the package ESM-only unless there is a specific compatibility requirement.
- Do not add a dependency on a full MCP framework unless it remains a thin transport adapter.
