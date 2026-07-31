# React MCP App

This Bun, Elysia, React 19, and `@modelcontextprotocol/ext-apps` example provides a responsive
task board, host-context handling, a model-visible launch tool, and an app-only mutation. The
checked-in shadcn-style source and Tailwind CSS compile into one standalone HTML file without
Vite, a CDN, or runtime asset fetches.

```bash
bun run build
bun run smoke
bun run server.ts
```

The bounded host fixture in `../apps-host-fixture.ts` is protocol test infrastructure, not a
production MCP Apps host.
