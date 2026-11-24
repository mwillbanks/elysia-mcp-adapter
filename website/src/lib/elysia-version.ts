export type ElysiaVersion = "1" | "2";

export const ELYSIA_VERSION_STORAGE_KEY = "elysia-mcp-adapter.elysia-version";

export function readElysiaVersion(storage: Pick<Storage, "getItem">): ElysiaVersion {
  try {
    return storage.getItem(ELYSIA_VERSION_STORAGE_KEY) === "2" ? "2" : "1";
  } catch {
    return "1";
  }
}

export function saveElysiaVersion(storage: Pick<Storage, "setItem">, version: ElysiaVersion): void {
  try {
    storage.setItem(ELYSIA_VERSION_STORAGE_KEY, version);
  } catch {
    // The selected version still applies when browser storage is unavailable.
  }
}

export function versionedExamplesMarkdown(markdown: string): string {
  return markdown
    .replace(/<ElysiaVersions>\s*/g, "")
    .replace(/<ElysiaVersion value=["']([12])["']>\s*/g, "#### Elysia $1\n\n")
    .replace(/\s*<\/ElysiaVersion>/g, "\n")
    .replace(/\s*<\/ElysiaVersions>/g, "\n");
}
