import { describe, expect, test } from "bun:test";
import { MCP_EXTENSION_SUPPORT } from "../../../src/extensions/manifest";
import { getExtensionSupportMarkdown, getExtensionSupportRows } from "../lib/extension-support";

describe("extension support table", () => {
  test("derives every supported extension profile from the exported manifest", () => {
    const rows = getExtensionSupportRows();
    expect(rows.map(({ identifier }) => identifier)).toEqual([
      "MCP",
      MCP_EXTENSION_SUPPORT.tasks.identifier,
      MCP_EXTENSION_SUPPORT.auth.identifier,
      MCP_EXTENSION_SUPPORT.auth.clientCredentials.identifier,
      MCP_EXTENSION_SUPPORT.auth.enterpriseManagedAuthorization.identifier,
      MCP_EXTENSION_SUPPORT.apps.identifier,
    ]);
    expect(rows.find(({ extension }) => extension === "Apps")).toMatchObject({
      current: MCP_EXTENSION_SUPPORT.apps.current,
      draft: MCP_EXTENSION_SUPPORT.apps.draft,
    });
    expect(
      rows.flatMap(({ versions }) => versions).every(({ record }) => record.source.sha256),
    ).toBe(true);
    expect(getExtensionSupportMarkdown()).toContain(
      MCP_EXTENSION_SUPPORT.apps.versions.draft.source.sha256,
    );
  });
});
