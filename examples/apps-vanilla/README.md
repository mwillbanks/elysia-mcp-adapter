# Vanilla MCP App

This Bun and Elysia example exposes a model-visible weather tool, an app-only refresh action,
and one self-contained `ui://` resource. Bun produces standalone HTML without Vite, CDNs,
runtime assets, or browser filesystem access.

```bash
bun run build
bun run smoke
bun run server.ts
```

The server imports the adapter from its public package root. Build the repository root before
running this example from a checkout.
