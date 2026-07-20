import { afterEach, describe, expect, mock, test } from "bun:test";

import { toJSONAsync } from "seroval";
import {
  basePathStaticFunctionMiddleware,
  createStaticCacheUrl,
} from "./static-function-middleware";

type StartStorage = {
  run<T>(context: { startOptions: Record<string, never> }, callback: () => T): T;
};

const startStorage = (globalThis as unknown as Record<symbol, StartStorage | undefined>)[
  Symbol.for("tanstack-start:start-storage-context")
];
if (!startStorage) {
  throw new Error("TanStack Start storage is not configured");
}

const originalNodeEnv = process.env.NODE_ENV;
const originalBaseUrl = process.env.BASE_URL;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalFetch = globalThis.fetch;

const clientMiddleware = basePathStaticFunctionMiddleware.options.client;
if (!clientMiddleware) {
  throw new Error("Static function client middleware is not configured");
}

function browserContext(id: string, data: unknown, next = mock(async () => ({ result: "next" }))) {
  return {
    context: { existing: true },
    data,
    filename: "test",
    method: "GET",
    next,
    sendContext: {},
    serverFnMeta: { id },
    signal: new AbortController().signal,
  } as never;
}

afterEach(() => {
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }

  if (originalBaseUrl === undefined) {
    Reflect.deleteProperty(process.env, "BASE_URL");
  } else {
    process.env.BASE_URL = originalBaseUrl;
  }

  if (originalDocument) {
    Object.defineProperty(globalThis, "document", originalDocument);
  } else {
    Reflect.deleteProperty(globalThis, "document");
  }

  globalThis.fetch = originalFetch;
});

describe("static server-function cache URLs", () => {
  test("prefixes cache requests with the GitHub Pages project base", async () => {
    const url = await createStaticCacheUrl(
      "d7362199f2790c94739a6e70419e65bee0e882309507c27e268208d9323850b9",
      ["getting-started", "quick-start"],
      "/elysia-mcp-adapter/",
    );

    expect(url).toBe(
      "/elysia-mcp-adapter/__tsr/staticServerFnCache/863221e14717e21b5e202eca5c47ae1f368ab7a4.json",
    );
  });

  test("normalizes project and root deployments", async () => {
    const projectUrl = await createStaticCacheUrl("fn", "a/b c", "elysia-mcp-adapter");
    const rootUrl = await createStaticCacheUrl("fn", { b: 2, a: 1 }, "/");

    expect(projectUrl).toMatch(
      /^\/elysia-mcp-adapter\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/,
    );
    expect(rootUrl).toMatch(/^\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/);
  });

  test("loads and reuses a serialized static result in the browser", async () => {
    process.env.NODE_ENV = "production";
    process.env.BASE_URL = "/elysia-mcp-adapter/";
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {},
    });

    const serialized = await toJSONAsync({
      context: { cached: true },
      result: { path: "quick-start" },
    });
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(serialized), {
          headers: { "content-type": "application/json; charset=utf-8" },
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = (await startStorage.run({ startOptions: {} }, () =>
      clientMiddleware(browserContext("success-cache", ["quick-start"])),
    )) as unknown as {
      context: Record<string, unknown>;
      result: unknown;
    };
    const second = (await startStorage.run({ startOptions: {} }, () =>
      clientMiddleware(browserContext("success-cache", ["quick-start"])),
    )) as unknown as {
      context: Record<string, unknown>;
      result: unknown;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(
      /^\/elysia-mcp-adapter\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/,
    );
    expect(first).toEqual({
      context: { cached: true, existing: true },
      result: { path: "quick-start" },
    });
    expect(second).toEqual(first);
  });

  test("reports missing or non-JSON cache artifacts clearly", async () => {
    process.env.NODE_ENV = "production";
    process.env.BASE_URL = "/elysia-mcp-adapter/";
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {},
    });
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("<!DOCTYPE html>", {
          headers: { "content-type": "text/html" },
          status: 404,
          statusText: "Not Found",
        }),
    ) as unknown as typeof fetch;

    expect(clientMiddleware(browserContext("missing-cache", ["missing"]))).rejects.toThrow(
      "Unable to load static server-function cache /elysia-mcp-adapter/__tsr/staticServerFnCache/",
    );
  });

  test("falls through outside a production browser", async () => {
    process.env.NODE_ENV = "test";
    Reflect.deleteProperty(globalThis, "document");
    const next = mock(async () => ({ result: "next" }));

    const result = await clientMiddleware(browserContext("server-render", undefined, next));

    expect(next).toHaveBeenCalledTimes(1);
    expect(result as unknown).toEqual({ result: "next" });
  });
});
