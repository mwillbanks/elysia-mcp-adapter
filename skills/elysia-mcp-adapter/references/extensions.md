# Select MCP extensions and revisions

1. Identify the client's core revision and the extension wire contract it implements. Check the installed adapter's exported `MCP_EXTENSION_SUPPORT` manifest for supported revisions and the public configuration type for the selector.
2. Enable only the extensions required by the task. Pin an exact revision when client interoperability depends on its wire contract. Check which provider or host policy the extension requires. For example, configure a durable provider if Tasks must survive process restarts.
3. Check the upstream maturity, the approval of the exact wire revision, and the adapter's support separately. A Beta extension can have an approved baseline and a separate unapproved draft. A proposal in an upstream pull request alone does not establish implementable support.
4. Enable supported draft behavior explicitly and plan a client check on each adapter update. A patch may replace the draft pin and wire contract. If an exact pin becomes obsolete, follow the adapter's migration guidance and verify the replacement with the client. Retire use of deprecated selectors before their documented removal.
5. Verify capability discovery with the extension enabled and disabled. Exercise the advertised method with the client's revision and confirm that an obsolete or unsupported selector fails at configuration.

For Events, use the accepted SEP-3415 pin. Read `heartbeatMs` from each `notifications/events/active` message and use the granted idle interval to monitor the stream. The configured server interval supplies the default and ceiling.

Use Skills over MCP when the application serves skills through its MCP endpoint. Use the package's Intent skill for agent guidance while developing the application.

Use `diagnostics.specificationNotices` to route lifecycle notices to the host logger or the host's OpenTelemetry Logs provider. The adapter emits an information notice for pre-release behavior and a warning with migration guidance for a deprecation. Keep these diagnostics separate from MCP protocol logging.

See the [extension catalog](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions), [version selection](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/versioning), [specification inventory](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/specification-inventory), and [specification notices](https://mwillbanks.github.io/elysia-mcp-adapter/docs/core-concepts/specification-notices).
