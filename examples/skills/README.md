# Skills over MCP example

This Bun example registers exact `SKILL.md` and supporting-file bytes with `.mcpSkill()`.
The client pages `skills/list`, performs a direct `skills/get`, reads each resource, and verifies
its byte size and SHA-256 digest before use. The fixture includes a zero-byte text resource to
verify that empty `text` content remains distinct from binary `blob` content.

Run it with:

```bash
bun run test
bun run smoke
```

The adapter serves skill content as untrusted data. A host must identify the source server,
obtain per-skill approval, bind approval to the complete manifest, verify every read, and gate
all local execution and permission grants. The adapter never executes a skill or resolves its
URI through DNS or the local filesystem.
