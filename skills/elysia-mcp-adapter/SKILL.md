---
name: elysia-mcp-adapter
description: Use when integrating @mwillbanks/elysia-mcp-adapter into an Elysia application, exposing HTTP routes or standalone MCP primitives, configuring MCP HTTP transport or authorization, or choosing compatible MCP extension revisions.
license: MIT
metadata:
  type: core
  library: '@mwillbanks/elysia-mcp-adapter'
  library_version: '0.7.0' # x-release-please-version
sources:
  - README.md
  - website/content/docs/getting-started/migration-elysia-2.mdx
  - website/content/docs/api-reference/route-backed-tools.mdx
  - website/content/docs/api-reference/standalone-primitives.mdx
  - website/content/docs/core-concepts/security.mdx
  - website/content/docs/core-concepts/specification-notices.mdx
  - website/content/docs/core-concepts/transportation.mdx
  - website/content/docs/extensions/authorization/configuration.mdx
  - website/content/docs/extensions/index.mdx
  - website/content/docs/extensions/specification-inventory.mdx
  - website/content/docs/extensions/versioning.mdx
---

# Elysia MCP Adapter

Resolve the consuming application's installed Elysia version from its package manifest, lockfile, and resolved package before choosing route syntax or companion dependencies. Support Elysia 1.4 and 2.0.0-rc.5 with the same adapter import and MCP API. Require Node.js >=22.18 when using Node.

Check the installed adapter version and the client's negotiated protocol revision before choosing options or extension pins. Use the installed package's types and extension support manifest to verify the available configuration.

Open the reference that matches the task:

- [Elysia compatibility and migration](references/elysia-migration.md) for version detection, route syntax, companion dependencies, migration checks, and runnable examples.

- [Route exposure](references/route-exposure.md) for mapping existing Elysia routes to tools and preserving route hooks.
- [Standalone primitives](references/standalone-primitives.md) for registering tools, resources, resource templates, or prompts without adding routes.
- [Transport and authorization](references/transport-authorization.md) for configuring or diagnosing the MCP endpoint and its credential boundaries.
- [Extension selection](references/extensions.md) for selecting approved or opt-in draft revisions and handling upgrades or retirement.

Keep the application responsible for authorization and data access. Check discovery and exercise a representative MCP call through the mounted endpoint before handing off changes.
