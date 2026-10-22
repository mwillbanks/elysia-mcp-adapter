import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const websiteRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = resolve(websiteRoot, "..");
const extensionsRoot = resolve(websiteRoot, "content/docs/extensions");
const canonicalMatrix = "https://modelcontextprotocol.io/extensions/client-matrix";

function read(path: string): string {
  return readFileSync(resolve(extensionsRoot, path), "utf8");
}

describe("extension documentation", () => {
  test("provides a complete documentation tree for every implemented extension", () => {
    for (const extension of ["tasks", "authorization", "apps"]) {
      expect(JSON.parse(read(`${extension}/meta.json`)).pages).toEqual([
        "index",
        "quick-start",
        "configuration",
        "examples",
      ]);
      for (const page of ["index", "quick-start", "configuration", "examples"]) {
        expect(existsSync(resolve(extensionsRoot, extension, `${page}.mdx`))).toBe(true);
      }
    }
  });

  test("uses the exported manifest table and only the canonical client matrix", () => {
    const overview = read("index.mdx");
    expect(overview).toContain("<ExtensionSupportTable />");
    expect(overview).toContain("<Mermaid");

    const docs = [
      overview,
      read("security.mdx"),
      read("authorization/index.mdx"),
      read("apps/examples.mdx"),
    ].join("\n");
    expect(docs).toContain(canonicalMatrix);
    expect(docs).not.toMatch(/claude|cursor|chatgpt|visual studio code/i);
  });

  test("documents current revisions and undefined experiments without implementation claims", () => {
    expect(read("specification-inventory.mdx")).toContain("2026-10-22");
    expect(read("specification-inventory.mdx")).toContain(
      "File Uploads and Filesystems are undefined experiments",
    );
    expect(read("experimental/interceptors.mdx")).toContain("interceptor-service.ts");
    expect(read("experimental/events.mdx")).toContain("-32027");
    expect(read("skills/configuration.mdx")).toContain("io.modelcontextprotocol.skills/");
    expect(read("tasks/configuration.mdx")).toContain("draft-b3d28ac");
    expect(read("server-card.mdx")).not.toContain("status: 'experimental'");
  });

  test("links every documented repository example to an implemented directory", () => {
    for (const path of [
      "examples/tasks/subprocess",
      "examples/tasks/bullmq",
      "examples/auth/oauth",
      "examples/auth/enterprise",
      "examples/apps-vanilla",
      "examples/apps-react",
      "examples/core",
      "examples/skills",
      "examples/experimental",
      "examples/events",
    ]) {
      expect(existsSync(resolve(repositoryRoot, path))).toBe(true);
    }
  });
});
