export interface LLMPage {
  data: {
    getText(type: "processed"): Promise<string>;
    title: string;
  };
  url: string;
}

function normalizeBasePath(basePath: string): string {
  if (basePath === "/") return "";

  const withLeadingSlash = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

export function withBasePath(path: string, basePath: string): string {
  return `${normalizeBasePath(basePath)}${path}`;
}

export function withBasePathInMarkdown(markdown: string, basePath: string): string {
  const normalized = normalizeBasePath(basePath);
  if (normalized.length === 0) return markdown;

  return markdown.replaceAll("](/", `](${normalized}/`);
}

export async function getLLMText(page: LLMPage, basePath: string): Promise<string> {
  const processed = (await page.data.getText("processed")).replace(
    "<ExtensionSupportTable />",
    getExtensionSupportMarkdown(),
  );
  const content = `# ${page.data.title} (${withBasePath(page.url, basePath)})\n\n${processed}`;
  return withBasePathInMarkdown(content, basePath);
}

export async function getLLMFullText(pages: LLMPage[], basePath: string): Promise<string> {
  return (await Promise.all(pages.map((page) => getLLMText(page, basePath)))).join("\n\n");
}

export function textResponse(
  body: string,
  contentType: "text/markdown" | "text/plain",
  init?: ResponseInit,
): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", `${contentType}; charset=utf-8`);

  return new Response(body, { ...init, headers });
}

export async function pageMarkdownResponse(
  page: LLMPage | undefined,
  basePath: string,
): Promise<Response> {
  if (!page) {
    return textResponse("Not Found", "text/plain", { status: 404 });
  }

  return textResponse(await getLLMText(page, basePath), "text/markdown");
}
import { getExtensionSupportMarkdown } from "./extension-support";
