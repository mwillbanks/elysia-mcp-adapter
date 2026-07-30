import { describe, expect, test } from "bun:test";
import {
  getLLMFullText,
  getLLMText,
  pageMarkdownResponse,
  withBasePath,
  withBasePathInMarkdown,
  type LLMPage,
} from "./llm";

function page(title: string, url: string, markdown: string): LLMPage {
  return {
    data: {
      getText: async () => markdown,
      title,
    },
    url,
  };
}

describe("LLM documentation rendering", () => {
  test("adds a deployment base path to canonical and Markdown URLs", async () => {
    const rendered = await getLLMText(
      page("Quick Start", "/docs/getting-started/quick-start", "[API](/docs/reference/types)"),
      "/elysia-mcp-adapter/",
    );

    expect(rendered).toContain(
      "# Quick Start (/elysia-mcp-adapter/docs/getting-started/quick-start)",
    );
    expect(rendered).toContain("[API](/elysia-mcp-adapter/docs/reference/types)");
  });

  test("keeps root-hosted URLs unchanged", () => {
    expect(withBasePath("/docs", "/")).toBe("/docs");
    expect(withBasePathInMarkdown("[Docs](/docs)", "/")).toBe("[Docs](/docs)");
  });

  test("renders every page in source order", async () => {
    const rendered = await getLLMFullText(
      [page("One", "/docs/one", "First"), page("Two", "/docs/two", "Second")],
      "/",
    );

    expect(rendered).toBe("# One (/docs/one)\n\nFirst\n\n# Two (/docs/two)\n\nSecond");
  });

  test("returns Markdown for an existing page", async () => {
    const response = await pageMarkdownResponse(
      page("Overview", "/docs", "Welcome"),
      "/elysia-mcp-adapter/",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe("# Overview (/elysia-mcp-adapter/docs)\n\nWelcome");
  });

  test("returns a typed 404 response for a missing page", async () => {
    const response = await pageMarkdownResponse(undefined, "/");

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Not Found");
  });
});
