import { getExtensionSupportRows } from "../lib/extension-support";

function shortRevision(revision: string): string {
  return revision.startsWith("v") ? revision : revision.slice(0, 12);
}

export function ExtensionSupportTable() {
  return (
    <div className="my-6 overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <thead className="bg-fd-muted">
          <tr>
            <th className="p-3">Extension</th>
            <th className="p-3">Current / draft</th>
            <th className="p-3">Pinned implementations</th>
          </tr>
        </thead>
        <tbody>
          {getExtensionSupportRows().map((row) => (
            <tr className="border-t align-top" key={row.identifier}>
              <td className="p-3">
                <strong>{row.extension}</strong>
                <br />
                <code>{row.identifier}</code>
              </td>
              <td className="p-3">
                <code>{row.current}</code>
                <br />
                <span className="text-fd-muted-foreground">Draft: {row.draft}</span>
              </td>
              <td className="p-3">
                {row.versions.map(({ version, record }) => (
                  <details className="mb-2 last:mb-0" key={version}>
                    <summary className="cursor-pointer">
                      <code>{version}</code> · {record.status} · included {record.includedAt}
                    </summary>
                    <div className="mt-2 break-all text-xs text-fd-muted-foreground">
                      <a
                        href={`${record.source.repository}/blob/${record.source.revision}/${record.source.path}`}
                      >
                        {shortRevision(record.source.revision)} · {record.source.path}
                      </a>
                      {record.source.packageVersion ? (
                        <div>Package: {record.source.packageVersion}</div>
                      ) : null}
                      <div>SHA-256: {record.source.sha256}</div>
                    </div>
                  </details>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
