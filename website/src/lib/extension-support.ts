import { MCP_SPECIFICATION_INVENTORY } from "../../../src/extensions/governance";
import { MCP_EXTENSION_SUPPORT } from "../../../src/extensions/manifest";

type SpecificationStage =
  (typeof MCP_SPECIFICATION_INVENTORY)[keyof typeof MCP_SPECIFICATION_INVENTORY]["stage"];

type VersionRecord = {
  status: string;
  includedAt: string;
  source: {
    repository: string;
    revision: string;
    path: string;
    sha256: string;
    packageVersion?: string;
  };
};

export interface ExtensionSupportRow {
  extension: string;
  identifier: string;
  maturity: SpecificationStage;
  current: string;
  draft: string;
  versions: Array<{ version: string; record: VersionRecord }>;
}

type SupportProfile = {
  identifier: string;
  current: string;
  draft?: string;
  versions: Record<string, VersionRecord>;
};

function supportRow(
  extension: string,
  profile: SupportProfile,
  maturity: SpecificationStage,
): ExtensionSupportRow {
  return {
    extension,
    identifier: profile.identifier,
    maturity,
    current: profile.current,
    draft: profile.draft ?? "—",
    versions: Object.entries(profile.versions).map(([version, record]) => ({ version, record })),
  };
}

export function getExtensionSupportRows(): ExtensionSupportRow[] {
  const support = MCP_EXTENSION_SUPPORT;
  const inventory = MCP_SPECIFICATION_INVENTORY;
  return [
    supportRow("Core protocol", { ...support.protocol, identifier: "MCP" }, inventory.core.stage),
    supportRow("Tasks", support.tasks, inventory.tasks.stage),
    supportRow(
      "OAuth protected resource",
      { ...support.auth, draft: "draft" },
      inventory.core.stage,
    ),
    supportRow(
      "OAuth Client Credentials",
      support.auth.clientCredentials,
      inventory.clientCredentials.stage,
    ),
    supportRow(
      "Enterprise-Managed Authorization",
      support.auth.enterpriseManagedAuthorization,
      inventory.enterpriseAuth.stage,
    ),
    supportRow("Apps", support.apps, inventory.apps.stage),
    supportRow("Skills", support.skills, inventory.skills.stage),
    supportRow("Server Cards", support.serverCard, inventory.serverCard.stage),
    supportRow("Interceptors", support.interceptors, inventory.interceptors.stage),
    supportRow("Server Variants", support.variants, inventory.serverVariants.stage),
    supportRow("Events", support.events, inventory.events.stage),
    supportRow("Action metadata", support.actionMetadata, inventory.actionMetadata.stage),
    supportRow("Trust annotations", support.trustAnnotations, inventory.trustAnnotations.stage),
  ];
}

export function getExtensionSupportMarkdown(): string {
  const header = [
    "| Extension | Identifier | Upstream maturity | Current | Draft | Implementations |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const rows = getExtensionSupportRows().map((row) => {
    const versions = row.versions
      .map(({ version, record }) => {
        const revision = record.source.revision.startsWith("v")
          ? record.source.revision
          : record.source.revision.slice(0, 12);
        const packageVersion = record.source.packageVersion
          ? `; package ${record.source.packageVersion}`
          : "";
        const sourceUrl = `${record.source.repository}/blob/${record.source.revision}/${record.source.path}`;
        return `\`${version}\` ${record.status}, included ${record.includedAt}, [${revision} ${record.source.path}](${sourceUrl}), SHA-256 ${record.source.sha256}${packageVersion}`;
      })
      .join("<br>");
    return `| ${row.extension} | \`${row.identifier}\` | ${row.maturity} | \`${row.current}\` | ${row.draft === "—" ? row.draft : `\`${row.draft}\``} | ${versions} |`;
  });
  return [...header, ...rows].join("\n");
}
