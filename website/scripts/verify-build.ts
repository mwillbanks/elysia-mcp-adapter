import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MCP_EXTENSION_SUPPORT } from "../../src/extensions/manifest";

const publicRoot = resolve(import.meta.dirname, "../.output/public");
const configuredBase = process.env.VITE_BASE_PATH ?? "/";
const base = configuredBase === "/" ? "" : `/${configuredBase.replace(/^\/+|\/+$/g, "")}`;

const extensionPages = ["tasks", "authorization", "apps", "skills"].flatMap((extension) => {
  const children = ["quick-start", "configuration"];
  children.push(extension === "skills" ? "security" : "examples");
  return [extension, ...children.map((child) => `${extension}/${child}`)];
});
const integrationPages = [
  "core-concepts/modern-core",
  "api-reference/plugin",
  "api-reference/extensions",
  "extensions/specification-inventory",
  "extensions/server-card",
  "extensions/experimental",
  "extensions/experimental/server-card",
  "extensions/experimental/interceptors",
  "extensions/experimental/server-variants",
  "extensions/experimental/annotations",
  "extensions/experimental/events",
];

function required(path: string): string {
  const absolute = resolve(publicRoot, path);
  if (!existsSync(absolute)) throw new Error(`Missing generated documentation artifact: ${path}`);
  return readFileSync(absolute, "utf8");
}

for (const page of extensionPages) {
  required(`docs/extensions/${page}/index.html`);
  required(`docs/extensions/${page}.md`);
}
for (const page of integrationPages) {
  required(`docs/${page}/index.html`);
  required(`docs/${page}.md`);
}

const overviewHtml = required("docs/extensions/index.html");
const overviewMarkdown = required("docs/extensions.md");
const llms = required("llms.txt");
const llmsFull = required("llms-full.txt");

for (const title of [
  "Tasks overview",
  "Authorization overview",
  "Apps overview",
  "Skills over MCP",
  "Server Cards",
  "Modern Core Protocol",
  "Experimental extensions",
  "Events",
]) {
  if (!llms.includes(title) || !llmsFull.includes(title)) {
    throw new Error(`Generated LLM documentation is missing: ${title}`);
  }
}

const draftHash = MCP_EXTENSION_SUPPORT.apps.versions.draft.source.sha256;
if (!overviewHtml.includes(draftHash) || !overviewMarkdown.includes(draftHash)) {
  throw new Error("Rendered and machine-readable support tables must include manifest provenance");
}

if (base) {
  for (const content of [overviewHtml, llms, llmsFull, overviewMarkdown]) {
    if (/(?:href|src)=["']\/(?:assets|docs)(?:\/|["'])/.test(content)) {
      throw new Error("Generated documentation contains a root-only internal link");
    }
  }
  if (!llms.includes(`${base}/docs/extensions/tasks`)) {
    throw new Error(`Generated LLM links do not include deployment base path ${base}`);
  }
}

console.log(
  `Verified ${extensionPages.length + integrationPages.length + 4} documentation artifacts for ${base || "/"}`,
);
