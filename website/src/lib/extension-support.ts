import { MCP_EXTENSION_SUPPORT } from "../../../src/extensions/manifest";

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
  current: string;
  draft: string;
  versions: Array<{ version: string; record: VersionRecord }>;
}

export function getExtensionSupportRows(): ExtensionSupportRow[] {
  const support = MCP_EXTENSION_SUPPORT;
  return [
    {
      extension: "Core protocol",
      identifier: "MCP",
      current: support.protocol.current,
      draft: "—",
      versions: Object.entries(support.protocol.versions).map(([version, record]) => ({
        version,
        record,
      })),
    },
    {
      extension: "Tasks",
      identifier: support.tasks.identifier,
      current: support.tasks.current,
      draft: support.tasks.draft,
      versions: Object.entries(support.tasks.versions).map(([version, record]) => ({
        version,
        record,
      })),
    },
    {
      extension: "OAuth protected resource",
      identifier: support.auth.identifier,
      current: support.auth.current,
      draft: "draft",
      versions: Object.entries(support.auth.versions).map(([version, record]) => ({
        version,
        record,
      })),
    },
    {
      extension: "OAuth Client Credentials",
      identifier: support.auth.clientCredentials.identifier,
      current: support.auth.clientCredentials.current,
      draft: support.auth.clientCredentials.draft,
      versions: Object.entries(support.auth.clientCredentials.versions).map(
        ([version, record]) => ({ version, record }),
      ),
    },
    {
      extension: "Enterprise-Managed Authorization",
      identifier: support.auth.enterpriseManagedAuthorization.identifier,
      current: support.auth.enterpriseManagedAuthorization.current,
      draft: "—",
      versions: Object.entries(support.auth.enterpriseManagedAuthorization.versions).map(
        ([version, record]) => ({ version, record }),
      ),
    },
    {
      extension: "Apps",
      identifier: support.apps.identifier,
      current: support.apps.current,
      draft: support.apps.draft,
      versions: Object.entries(support.apps.versions).map(([version, record]) => ({
        version,
        record,
      })),
    },
  ];
}

export function getExtensionSupportMarkdown(): string {
  const header = [
    "| Extension | Identifier | Current | Draft | Implementations |",
    "| --- | --- | --- | --- | --- |",
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
    return `| ${row.extension} | \`${row.identifier}\` | \`${row.current}\` | ${row.draft === "—" ? row.draft : `\`${row.draft}\``} | ${versions} |`;
  });
  return [...header, ...rows].join("\n");
}
