# Configure MCP HTTP transport and authorization

Use the endpoint path configured by the application. The default is `/mcp`. Send JSON-RPC requests as JSON and accept both `application/json` and `text/event-stream`.

1. Check the client's revision. Use `server/discover` for the `2026-07-28` discovery flow and `initialize` for classic clients. Headerless requests without version metadata use the configured classic version when enabled. For classic HTTP clients, send the negotiated version in `MCP-Protocol-Version` on subsequent requests.
2. For modern requests, send the same revision in `MCP-Protocol-Version` and `params._meta["io.modelcontextprotocol/protocolVersion"]`. Provide the required client capability metadata and match `Mcp-Method` and, where required, `Mcp-Name` to the JSON-RPC request.
3. Keep origin validation enabled. Configure exact trusted origins for browser clients and test both a permitted origin and a rejected one.
4. For a protected endpoint, use the adapter's `extensions.auth` options with a verifier backed by the host's authorization server or identity provider. Validate credentials for the intended resource, including audience, expiry, and required scope. Apply application authorization at the route or handler that owns the operation.
5. Use approved inbound credential forwarding for route-backed operations. Keep model-supplied headers denied by default. When the application needs a model-controlled header, allow only the required header and exclude credential-bearing values from tool output.
6. Test a valid request, an invalid protocol mirror, and unauthenticated or insufficiently authorized requests through the actual endpoint. Check both MCP endpoint authorization and the backing route's authorization.

See [transport](https://mwillbanks.github.io/elysia-mcp-adapter/docs/core-concepts/transportation), [security](https://mwillbanks.github.io/elysia-mcp-adapter/docs/core-concepts/security), and [authorization configuration](https://mwillbanks.github.io/elysia-mcp-adapter/docs/extensions/authorization/configuration).
