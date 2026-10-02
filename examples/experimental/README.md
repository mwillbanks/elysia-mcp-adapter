# Experimental extensions

This Bun workspace exercises five opt-in experiments against the adapter itself:

- server-card discovery and conditional caching;
- interceptor discovery, invocation, sending and receiving order, isolated mutation and validation, audit failure outcomes, and local chaining;
- legacy server-variant discovery, selection, pagination limits, and principal-bound sessions;
- variant-bound resource subscriptions and teardown;
- action metadata and trust annotations, including absent versus `false` fields.

Run `bun --bun run test`, `bun --bun run smoke`, and `bun --bun run build` here. The clients call `app.handle(new Request(...))`, so every request uses the actual adapter transport. They open no network connections.

These experiments are disabled unless configured. Pin each revision shown in `server.ts` before production evaluation.
