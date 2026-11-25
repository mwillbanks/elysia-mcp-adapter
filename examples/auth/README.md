# Elysia MCP authentication examples

## Elysia versions

The existing project runs with Elysia `1.4.32`. Both versions use the shared [OAuth server](./oauth/app.ts) and [enterprise server](./enterprise/app.ts).

Run the Elysia 1 project from the repository root:

```sh
bun run examples:setup
bun run build
bun run --cwd examples/auth build
bun run --cwd examples/auth typecheck
bun run --cwd examples/auth test
bun run --cwd examples/auth smoke
```

Run the same project with Elysia `2.0.0-rc.5`:

```sh
bun run examples:elysia2 -- auth
```

The runner packs the adapter, stages shared sources with the Elysia 2 overlays in a temporary workspace,
and runs build, type checks, tests, and smoke checks. It removes the workspace after completion.
Use `--archive /absolute/path/adapter.tgz` to reuse an existing adapter archive.
See the [Elysia 2 examples guide](../elysia-2/README.md) for requirements and migration details.

This independent Bun package contains two runnable integrations. Both use Bun SQLite, run Better Auth migrations programmatically at startup, and pass only verified, normalized access-token claims to `@mwillbanks/elysia-mcp-adapter`.

## OAuth 2.1 (`oauth/`)

The OAuth example uses Better Auth 1.7.21 and `@better-auth/oauth-provider` 1.7.21. Its tests execute both supported MCP client patterns against Better Auth's real endpoints:

- an authorization-code flow for a public native client with an S256 PKCE verifier;
- a `client_credentials` flow for a confidential workload.

The resource server verifies JWT signatures with public keys from the co-located Better Auth JWKS API and requires issuer, audience, expiry, token-kind, and `mcp:read` scope before constructing the adapter principal. Tests also cover protected-resource metadata, insufficient scope, malformed tokens, and an unregistered audience.

The local examples let an authenticated client owner create a workload client and provision only
the server-configured MCP scopes. Production deployments should replace this bounded policy with
operator-managed client and scope authorization.

## Enterprise (`enterprise/`)

The enterprise example combines `@better-auth/sso` 1.7.21 SAML with `@better-auth/oauth-provider` 1.7.21. It intentionally does not use the deprecated `oidcProvider` plugin. SAML is the interactive identity boundary; MCP still accepts only a final OAuth access token.

The checked-in test IdP endpoint is deterministic and deliberately stops before login. The integration test proves that Better Auth publishes SP metadata, creates an AuthnRequest, routes it to that configured endpoint, and rejects an unsigned/unrelated response at its ACS. A real deployment replaces `TEST_IDP_ENTRY_POINT` and supplies its IdP certificate through `SAML_IDP_CERT`. The SAML configuration requires correlated SP-initiated responses, signed assertions, timestamps, and non-deprecated algorithms. Direct SAML assertions and ID-JAG strings are rejected at the MCP bearer boundary.

The package does not manufacture a successful SAML assertion: doing so faithfully requires a separate SAML IdP implementation and its XML-signature stack, which would turn this adapter example into an IdP project. Instead, the automated boundary checks use Better Auth's real SSO entry, metadata, and ACS endpoints, while the successful half uses a confidential OAuth client to exercise real access-token issuance, JWKS verification, normalization, MCP discovery, and MCP use. The adapter advertises the enterprise profile but does not add permissions or trust claims based on grant provenance.

Tests generate a one-day IdP certificate and private key with local `openssl` in an OS temporary directory, load only the certificate, then delete both files. No certificate, private key, client secret, or application secret is committed.

## Run

Use Bun 1.4.4 and OpenSSL, then run from the repository root:

```bash
bun run examples:setup
bun run build
bun run --cwd examples/auth typecheck
bun run --cwd examples/auth test
bun run --cwd examples/auth smoke
```

For manual configuration, copy `.env.example`, generate a random Better Auth secret of at least 32 characters, and provide the IdP's PEM certificate. The examples use `http://localhost:43101` and `http://localhost:43102` as logical issuer and resource identifiers. Tests and smoke checks use `app.handle()` and the co-located JWKS API without opening listening sockets. Each verifier caches keys within its own application instance. The in-memory test database closes after each suite or smoke check.

Use Bun 1.4.4. Client Credentials and Enterprise-Managed Authorization default to their approved profiles. Token verification, audience binding, and credential redaction remain required.
