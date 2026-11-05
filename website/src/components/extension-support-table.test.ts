import { describe, expect, test } from "bun:test";
import { MCP_EXTENSION_SUPPORT } from "../../../src/extensions/manifest";
import { getExtensionSupportMarkdown, getExtensionSupportRows } from "../lib/extension-support";

describe("extension support table", () => {
  test("shows Beta maturity separately from approved wire status in both table views", () => {
    const rows = getExtensionSupportRows();
    const markdown = getExtensionSupportMarkdown();
    for (const profile of [
      MCP_EXTENSION_SUPPORT.tasks,
      MCP_EXTENSION_SUPPORT.skills,
      MCP_EXTENSION_SUPPORT.serverCard,
    ]) {
      const row = rows.find(({ identifier }) => identifier === profile.identifier);
      expect(row?.maturity).toBe(profile.maturity);
      expect(row?.versions.find(({ version }) => version === profile.current)?.record.status).toBe(
        "stable",
      );
      expect(markdown).toContain(`| \`${profile.identifier}\` | beta |`);
    }
  });

  test("derives every supported extension profile from the exported manifest", () => {
    const rows = getExtensionSupportRows();
    expect(rows.map(({ identifier }) => identifier)).toEqual([
      "MCP",
      MCP_EXTENSION_SUPPORT.tasks.identifier,
      MCP_EXTENSION_SUPPORT.auth.identifier,
      MCP_EXTENSION_SUPPORT.auth.clientCredentials.identifier,
      MCP_EXTENSION_SUPPORT.auth.enterpriseManagedAuthorization.identifier,
      MCP_EXTENSION_SUPPORT.apps.identifier,
      MCP_EXTENSION_SUPPORT.skills.identifier,
      MCP_EXTENSION_SUPPORT.serverCard.identifier,
      MCP_EXTENSION_SUPPORT.interceptors.identifier,
      MCP_EXTENSION_SUPPORT.variants.identifier,
      MCP_EXTENSION_SUPPORT.events.identifier,
      MCP_EXTENSION_SUPPORT.actionMetadata.identifier,
      MCP_EXTENSION_SUPPORT.trustAnnotations.identifier,
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
