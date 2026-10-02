# Vanilla MCP App

This Bun and Elysia example exposes a model-visible weather tool, an app-only refresh action,
and one self-contained `ui://` resource. It uses the MCP Apps v2 `App` API with the split client
peer and Zod v4. Its transport validates the parent window, pins the first valid origin, and applies
bounded request timeouts. Bun produces standalone HTML without Vite, CDNs, runtime assets, or
browser filesystem access.

From the repository root, register the checkout and install all example workspaces first:

```bash
bun run examples:setup
```

Then run these commands from `examples/apps-vanilla`:

```bash
bun run build
bun run smoke
bun run server.ts
```

The server imports the adapter from its public package root. Build the repository root before
running this example from a checkout.
