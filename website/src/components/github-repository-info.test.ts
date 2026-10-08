import { describe, expect, test } from "bun:test";
import { fetchGithubRepositoryStats } from "./github-repository-info";

describe("GitHub repository information", () => {
  test("returns repository counts and authenticates server requests", async () => {
    const fetchImpl = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
        return Response.json({ forks_count: 23, stargazers_count: 157 });
      },
      { preconnect() {} },
    ) satisfies typeof fetch;

    await expect(
      fetchGithubRepositoryStats("mwillbanks", "elysia-mcp-adapter", "test-token", fetchImpl),
    ).resolves.toEqual({ forks: 23, stars: 157 });
  });

  test("falls back when GitHub is unavailable or returns invalid data", async () => {
    const rateLimited = Object.assign(async () => new Response("rate limited", { status: 403 }), {
      preconnect() {},
    }) satisfies typeof fetch;
    const invalid = Object.assign(async () => Response.json({ stargazers_count: 157 }), {
      preconnect() {},
    }) satisfies typeof fetch;
    const unavailable = Object.assign(async () => Promise.reject(new Error("offline")), {
      preconnect() {},
    }) satisfies typeof fetch;

    await expect(
      fetchGithubRepositoryStats("mwillbanks", "elysia-mcp-adapter", undefined, rateLimited),
    ).resolves.toBeNull();
    await expect(
      fetchGithubRepositoryStats("mwillbanks", "elysia-mcp-adapter", undefined, invalid),
    ).resolves.toBeNull();
    await expect(
      fetchGithubRepositoryStats("mwillbanks", "elysia-mcp-adapter", undefined, unavailable),
    ).resolves.toBeNull();
  });
});
