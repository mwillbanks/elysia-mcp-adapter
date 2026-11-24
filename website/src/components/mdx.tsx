import { ElysiaVersion, ElysiaVersions } from "./elysia-version";
import { TypeTable } from "fumadocs-ui/components/type-table";
import { Mermaid } from "./mermaid";
import { ExtensionSupportTable } from "./extension-support-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ExtensionSupportTable,
    ElysiaVersion,
    ElysiaVersions,
    Mermaid,
    TypeTable,
    ...components,
  } satisfies MDXComponents;
}

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
