# Elysia MCP authentication examples

This independent Bun package contains two runnable integrations. Both use Bun SQLite, run Better Auth migrations programmatically at startup, and pass only verified, normalized access-token claims to `@mwillbanks/elysia-mcp-adapter`.

## OAuth 2.1 (`oauth/`)

The OAuth example uses Better Auth 1.6.25 and `@better-auth/oauth-provider` 1.6.25. Its tests execute both supported MCP client patterns against Better Auth's real endpoints:

- an authorization-code flow for a public native client with an S256 PKCE verifier;
- a `client_credentials` flow for a confidential workload.

The resource server verifies JWT signatures through Better Auth's JWKS endpoint and requires issuer, audience, expiry, token-kind, and `mcp:read` scope before constructing the adapter principal. Tests also cover protected-resource metadata, insufficient scope, malformed tokens, and an unregistered audience.

## Enterprise (`enterprise/`)

The enterprise example combines `@better-auth/sso` 1.6.25 SAML with `@better-auth/oauth-provider` 1.6.25. It intentionally does not use the deprecated `oidcProvider` plugin. SAML is the interactive identity boundary; MCP still accepts only a final OAuth access token.

The checked-in test IdP endpoint is deterministic and deliberately stops before login. The integration test proves that Better Auth publishes SP metadata, creates an AuthnRequest, routes it to that configured endpoint, and rejects an unsigned/unrelated response at its ACS. A real deployment replaces `TEST_IDP_ENTRY_POINT` and supplies its IdP certificate through `SAML_IDP_CERT`. The SAML configuration requires correlated SP-initiated responses, signed assertions, timestamps, and non-deprecated algorithms. Direct SAML assertions and ID-JAG strings are rejected at the MCP bearer boundary.

The package does not manufacture a successful SAML assertion: doing so faithfully requires a separate SAML IdP implementation and its XML-signature stack, which would turn this adapter example into an IdP project. Instead, the automated boundary checks use Better Auth's real SSO entry, metadata, and ACS endpoints, while the successful half uses a confidential OAuth client to exercise real access-token issuance, JWKS verification, normalization, MCP discovery, and MCP use. The adapter advertises the enterprise profile but does not add permissions or trust claims based on grant provenance.

Tests generate a one-day IdP certificate and private key with local `openssl` in an OS temporary directory, load only the certificate, then delete both files. No certificate, private key, client secret, or application secret is committed.

## Run

Use Bun 1.3.14 and OpenSSL, then run from the repository root:

```bash
bun run examples:setup
bun run build
bun run --cwd examples/auth typecheck
bun run --cwd examples/auth test
bun run --cwd examples/auth smoke
```

For manual configuration, copy `.env.example`, generate a random Better Auth secret of at least 32 characters, and provide the IdP's PEM certificate. The examples use fixed loopback ports `43101` and `43102`; they do not start production services or persist the in-memory test database.
