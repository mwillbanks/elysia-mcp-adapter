---
name: elysia-mcp-adapter
description: Use when integrating @mwillbanks/elysia-mcp-adapter into an Elysia application, exposing HTTP routes or standalone MCP primitives, configuring MCP HTTP transport or authorization, or choosing compatible MCP extension revisions.
license: MIT
metadata:
  type: core
  library: '@mwillbanks/elysia-mcp-adapter'
  library_version: '0.5.0'
sources:
  - README.md
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

Check the installed adapter version and the client's negotiated protocol revision before choosing options or extension pins. Use the installed package's types and extension support manifest to verify the available configuration.

Open the reference that matches the task:

- [Route exposure](references/route-exposure.md) for mapping existing Elysia routes to tools and preserving route hooks.
- [Standalone primitives](references/standalone-primitives.md) for registering tools, resources, resource templates, or prompts without adding routes.
- [Transport and authorization](references/transport-authorization.md) for configuring or diagnosing the MCP endpoint and its credential boundaries.
- [Extension selection](references/extensions.md) for selecting approved or opt-in draft revisions and handling upgrades or retirement.

Keep the application responsible for authorization and data access. Check discovery and exercise a representative MCP call through the mounted endpoint before handing off changes.
