# Integrate and migrate Elysia versions

Resolve the consuming application's installed Elysia version from its package manager before selecting syntax.
Use the lockfile and resolved dependency, including its prerelease identifier.
This adapter supports Elysia `^1.4.0` and `^2.0.0-rc.5`.
Use Node.js `>=22.18` with either version. The Elysia 2 Bun examples were qualified with Bun `1.4.4`; use that version or later for those examples.

Use the same adapter import and MCP fluent methods on both versions.
For Elysia 1, register a route with `app.get(path, handler, options)`.
For Elysia 2, use `app.get(path, options, handler)`.
Keep two-argument routes in their existing form.

## Migration checklist

1. Record passing application tests and the existing lockfile.
2. Keep the project on Elysia 1 and install the pinned migration tool with `bun add --dev --exact @elysia/codemod@2.0.0-rc.0`.
3. Preview changes with `bunx @elysia/codemod@2.0.0-rc.0 --check`.
4. Review warnings and the preview. Apply only after review with `bunx @elysia/codemod@2.0.0-rc.0`, then inspect the full application diff.
5. Update to Elysia `2.0.0-rc.5` and resolve companion plugins with Elysia 2 peer support.
6. Review guard and group schema precedence. Use `schema: 'merge'` when inherited and route schemas must both apply.
7. Review `resolve` to `derive`, `scoped` to `plugin`, and typed `onError` changes. The RC keeps `on` lifecycle names.
8. Verify macros, named models, schema overrides, problem JSON, and required file-type detection.
9. Compare MCP discovery and schemas, then invoke accepted, invalid, unauthorized, and forbidden requests.
10. Exercise each enabled extension and its provider through the mounted MCP endpoint.
11. Repeat these checks against the generated artifact when enabling AOT.

Use `@elysiajs/openapi@1.4.17`, `@elysiajs/bearer@1.4.4`, and `@elysiajs/opentelemetry@1.4.11` with Elysia 1.
Use `@elysia/openapi@2.0.0-rc.1`, `@elysia/bearer@2.0.0-rc.0`, and `@elysia/opentelemetry@2.0.0-rc.0` with Elysia 2.
The Elysia 2 OpenAPI RC requires a visible `typebox` dependency although its package does not declare it.
Qualification used `typebox@1.4.7` with `bun install --linker hoisted` in isolated consumers.
Live-socket packed consumers passed on Node.js `22.18` with `@elysiajs/node@1.4.5` for Elysia 1 and `@elysia/node@2.0.0-beta.3` for Elysia 2.
Use the matching Node adapter and check its actual published peer range before choosing another release.

Early Elysia 1.4 releases without macro introspection, including `1.4.0`, conservatively retain inherited `mcp: false` when a descendant opts in.
Use `1.4.32` or `2.0.0-rc.5` for local override precedence.

The qualified Elysia 2 fixture returned plain strings without `Content-Type`.
Set an explicit response MIME type for route-backed text when absent.
The packed Bun AOT fixture retained hidden-route exclusions and protected-route denials and acceptance on `2.0.0-rc.5`.
Still verify discovery and authorization against the consuming application's generated AOT artifact.

## Route example

### Elysia 1

```ts
app.get('/users/:id', ({ params }) => ({ id: params.id }), {
  params: t.Object({ id: t.String() }),
  detail: { operationId: 'users.get' },
  mcp: { annotations: { readOnlyHint: true } }
})
```

### Elysia 2

```ts
app.get(
  '/users/:id',
  {
    params: t.Object({ id: t.String() }),
    detail: { operationId: 'users.get' },
    mcp: { annotations: { readOnlyHint: true } }
  },
  ({ params }) => ({ id: params.id })
)
```

## Runnable qualification

Run `bun run examples:elysia2` in the adapter repository, or select a project with `bun run examples:elysia2 -- core`.
The runner tests the packed adapter with pinned Elysia 2 in an isolated workspace.
The existing example commands run Elysia 1.
Use the projects for [Core](https://github.com/mwillbanks/elysia-mcp-adapter/tree/main/examples/core),
[Apps Vanilla](https://github.com/mwillbanks/elysia-mcp-adapter/tree/main/examples/apps-vanilla),
[Apps React](https://github.com/mwillbanks/elysia-mcp-adapter/tree/main/examples/apps-react),
[Authorization](https://github.com/mwillbanks/elysia-mcp-adapter/tree/main/examples/auth),
[Tasks](https://github.com/mwillbanks/elysia-mcp-adapter/tree/main/examples/tasks),
[Skills](https://github.com/mwillbanks/elysia-mcp-adapter/tree/main/examples/skills),
[Events](https://github.com/mwillbanks/elysia-mcp-adapter/tree/main/examples/events), and
[Experimental Extensions](https://github.com/mwillbanks/elysia-mcp-adapter/tree/main/examples/experimental).

Read the [migration guide](https://mwillbanks.github.io/elysia-mcp-adapter/docs/getting-started/migration-elysia-2)
for dependencies, lifecycle changes, validation, and AOT qualification.
