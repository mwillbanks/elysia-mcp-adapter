# Experimental extensions

This Bun workspace exercises finalized Server Cards and opt-in experiments against the adapter itself:

- server-card discovery and conditional caching;
- interceptor discovery, invocation, sending and receiving order, isolated mutation and validation, audit failure outcomes, and local chaining;
- legacy server-variant discovery, selection, pagination limits, and principal-bound sessions;
- variant-bound resource subscriptions and teardown;
- action metadata and trust annotations, including absent versus `false` fields.

Run `bun --bun run test`, `bun --bun run smoke`, and `bun --bun run build` here. The clients call `app.handle(new Request(...))`, so every request uses the actual adapter transport. The separate interceptor service uses loopback HTTP in a child process. Other clients use in-process requests.

These experiments are disabled unless configured. Pin each revision shown in `server.ts` before production evaluation.

Use Bun 1.4.4. `interceptor-service.ts` hosts only interceptors. `remote-interceptor.ts` starts
that service, discovers it through HTTP, sends timestamp, trace, span, and session context,
and checks supplied configuration, omitted defaults, and invalid configuration rejection.
The child process terminates after each run. Local chain helpers are adapter utilities,
not remote-service orchestration. Principal claims in invocation context are untrusted.

Server Cards follow Final SEP-2127. Variants remain a legacy initialize experiment.
Action metadata and trust annotations remain experimental metadata, never authorization.
