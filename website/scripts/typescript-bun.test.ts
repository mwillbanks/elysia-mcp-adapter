import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createGenerator, createProject } from "fumadocs-typescript";

test("Bun generates semantic API tables and closes repeated native compiler sessions", async () => {
  for (let session = 0; session < 3; session++) {
    const project = await createProject({ tsconfigPath: resolve("tsconfig.json") });
    try {
      const generator = createGenerator({ project, cache: false });
      const path = resolve("scripts/virtual-api-fixture.ts");
      const first = await generator.generateDocumentation(
        { path, content: "export interface Fixture { required: string; optional?: number }" },
        "Fixture",
      );
      expect(first[0]?.entries.map(({ name, required }) => ({ name, required }))).toEqual([
        { name: "required", required: true },
        { name: "optional", required: false },
      ]);
      const updated = await generator.generateDocumentation(
        { path, content: "export interface Fixture { changed: boolean }" },
        "Fixture",
      );
      expect(updated[0]?.entries.map(({ name }) => name)).toEqual(["changed"]);
    } finally {
      project.close();
      project.close();
    }
  }
}, 30_000);
