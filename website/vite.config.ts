import { type Dirent, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const docsRoot = resolve(import.meta.dirname, "content/docs");

function isMarkdownFile(entry: Dirent): boolean {
  return entry.isFile() && entry.name.endsWith(".mdx");
}

function normalizePublicSlug(slug: string): string {
  if (slug.endsWith("/index")) return slug.slice(0, -"/index".length);
  return slug;
}

function toMarkdownPagePath(slug: string): string {
  if (slug === "index") return "/docs.md";
  return `/docs/${slug}.md`;
}

function getMarkdownPrerenderPage(directory: string, entry: Dirent): Array<{ path: string }> {
  const absolutePath = resolve(directory, entry.name);
  if (entry.isDirectory()) return getMarkdownPrerenderPages(absolutePath);
  if (!isMarkdownFile(entry)) return [];

  const relativePath = relative(docsRoot, absolutePath).split(sep).join("/");
  const slug = relativePath.slice(0, -".mdx".length);
  return [{ path: toMarkdownPagePath(normalizePublicSlug(slug)) }];
}

function getMarkdownPrerenderPages(directory = docsRoot): Array<{ path: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    getMarkdownPrerenderPage(directory, entry),
  );
}

const machineReadablePages = [
  { path: "/llms.txt" },
  { path: "/llms-full.txt" },
  ...getMarkdownPrerenderPages().sort((left, right) => left.path.localeCompare(right.path)),
];

const configuredBase = process.env.VITE_BASE_PATH ?? "/";
const base = configuredBase.endsWith("/") ? configuredBase : `${configuredBase}/`;

export default defineConfig({
  base,
  plugins: [
    mdx(),
    tailwindcss(),
    tanstackStart({
      pages: [{ path: "/docs" }, { path: "/api/search" }, ...machineReadablePages],
      spa: {
        enabled: true,
        prerender: {
          crawlLinks: true,
          enabled: true,
        },
      },
    }),
    react(),
    nitro(),
  ],
  resolve: { tsconfigPaths: true },
  server: {
    fs: {
      allow: [resolve(import.meta.dirname, "..")],
    },
    port: 3000,
  },
});
