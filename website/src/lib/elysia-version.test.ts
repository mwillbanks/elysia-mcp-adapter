import { describe, expect, test } from "bun:test";
import {
  ELYSIA_VERSION_STORAGE_KEY,
  readElysiaVersion,
  saveElysiaVersion,
  versionedExamplesMarkdown,
} from "./elysia-version";

describe("Elysia documentation version", () => {
  test("defaults to Elysia 1 and restores a saved Elysia 2 preference", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(readElysiaVersion(storage)).toBe("1");
    saveElysiaVersion(storage, "2");
    expect(readElysiaVersion(storage)).toBe("2");
    expect(values.get(ELYSIA_VERSION_STORAGE_KEY)).toBe("2");
    values.set(ELYSIA_VERSION_STORAGE_KEY, "unknown");
    expect(readElysiaVersion(storage)).toBe("1");
  });

  test("supports browsers that refuse persistent storage", () => {
    const storage = {
      getItem(): string | null {
        throw new Error("unavailable");
      },
      setItem(): void {
        throw new Error("unavailable");
      },
    };
    expect(readElysiaVersion(storage)).toBe("1");
    expect(() => saveElysiaVersion(storage, "2")).not.toThrow();
  });

  test("exports both examples with version headings", () => {
    const markdown =
      '<ElysiaVersions>\n<ElysiaVersion value="1">\n\n```ts\napp.get(path, handler, hooks)\n```\n\n</ElysiaVersion>\n<ElysiaVersion value="2">\n\n```ts\napp.get(path, hooks, handler)\n```\n\n</ElysiaVersion>\n</ElysiaVersions>';
    const rendered = versionedExamplesMarkdown(markdown);
    expect(rendered).toContain("#### Elysia 1");
    expect(rendered).toContain("#### Elysia 2");
    expect(rendered).toContain("app.get(path, handler, hooks)");
    expect(rendered).toContain("app.get(path, hooks, handler)");
    expect(rendered).not.toContain("<Elysia");
  });
});
