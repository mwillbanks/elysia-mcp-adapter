# Events extension example

This Bun workspace demonstrates the pinned experimental Events revision with `events/list`, replay polling, event-only POST SSE, and the adapter's complete webhook lifecycle. Its authenticated integration subscribes through JSON-RPC, completes a signed HTTPS challenge, receives signed events, refreshes with dual-secret rotation, restarts the adapter in another Bun process, recovers delivery from SQLite, and unsubscribes with the original tuple.

The event source uses an explicit bounded in-memory history. Producers publish stable occurrences; handlers replay retained occurrences from epoch-and-sequence cursors without creating events during polling. Fresh `null` starts at the current head. Evicted or prior-process epochs return a truncated gap. Applications needing replay across server restarts must persist event history separately from webhook subscription records.

Heartbeats create no events. They carry the current safe checked cursor so clients can persist progress during quiet periods. Poll results, push `active` messages, and subscribe or refresh results report gaps with `truncated: true` and a fresh cursor. Webhooks send the exact control payload `{ type: 'gap', cursor: '<fresh>' }`, which clients treat as the same truncated condition. Persist the fresh cursor and continue the same delivery without reconnecting or resubscribing. Applications can use separate recovery tools when missing history matters.

The durable provider uses SQLite `IMMEDIATE` transactions for atomic per-principal quotas. It preserves the original owner for every key, persists verification, secrets, TTL fields, replay-age bounds, and status, and rechecks authorization before delivery. It never stores client replay cursors.

A fresh webhook subscription sends `cursor: null` and receives a signed, non-null head cursor without replaying older events. The example requests a 15-second `maxAgeMs` bound and confirms that the provider persists this subscription setting. A stale cursor or replay-age floor reports `truncated`. The adapter may briefly finish an initial bounded backlog before returning a safe cursor, so the returned cursor never advances beyond unacknowledged events. Clients persist every returned cursor; providers never persist client checkpoints.

The webhook configuration grants 60 seconds by default, clamps smaller positive requests to 30 seconds, and clamps larger requests to 120 seconds. The lifecycle test exercises both clamps. Clients schedule refresh from the returned `refreshBefore` value rather than their requested duration.

The receiver authenticates the exact raw body bytes before parsing a challenge. Its bounded, process-local TTL cache suppresses duplicate application processing while valid retries still receive a successful acknowledgement. Production receivers should replace that cache with shared durable deduplication when multiple processes must coordinate.

The local authenticated server receives a random fixture bearer credential through its child-process environment and compares it exactly. Unknown credentials receive `401`. Production applications must inject an authoritative access-token verifier and an application policy that rechecks the stored principal during every `authorizeDelivery` call.

The restart demonstration is sequential and preserves one active adapter instance. Deployments sharing a durable provider across processes need external single-owner routing or leadership. The provider does not implement a distributed lease or compare-and-swap fencing contract.

Run `bun --bun run typecheck`, `bun --bun run test`, `bun --bun run build`, and `bun --bun run smoke`.

The production webhook transport keeps HTTPS certificate verification enabled. Private callback addresses require `environment: 'development'` and `allowPrivateAddresses: true`. Clients persist replay cursors; providers do not store them.
