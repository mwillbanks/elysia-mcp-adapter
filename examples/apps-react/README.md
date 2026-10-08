# React MCP App

This Bun, Elysia, React 19, and MCP Apps v2 example provides a responsive
task board, host-context handling, a model-visible launch tool, and an app-only mutation. The
checked-in shadcn-style source and Tailwind CSS compile into one standalone HTML file without
Vite, a CDN, or runtime asset fetches.

From the repository root, register the checkout and install all example workspaces first:

```bash
bun run examples:setup
```

Then run these commands from `examples/apps-react`:

```bash
bun run build
bun run smoke
bun run server.ts
```

The bounded host fixture in `../apps-host-fixture.ts` is protocol test infrastructure. Its tests
also connect the v2 `App` and `AppBridge` through SDK in-memory transports.
