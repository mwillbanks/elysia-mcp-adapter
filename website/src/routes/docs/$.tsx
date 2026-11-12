import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import { basePathStaticFunctionMiddleware } from "@/lib/static-function-middleware";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { createClientLoader } from "fumadocs-mdx/runtime/browser";
import browserCollections from "collections/browser";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { Suspense } from "react";
import { getMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/") ?? [];
    const data = await loadPage({ data: slugs });
    await clientLoader.preload(data.path);
    return data;
  },
});

const loadPage = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .middleware([basePathStaticFunctionMiddleware, staticFunctionMiddleware])
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    return {
      pageTree: await source.serializePageTree(source.getPageTree()),
      path: page.path,
    };
  });

type CompiledDoc = Awaited<ReturnType<(typeof browserCollections.docs.raw)[string]>>;
// Select the named exports so Fumadocs can omit output fields without widening the page type.
type BrowserDoc = Pick<CompiledDoc, "default" | "frontmatter" | "structuredData" | "toc">;

const clientLoader = createClientLoader<BrowserDoc>(browserCollections.docs.raw, {
  id: "docs",
  component({ default: MDX, frontmatter, toc }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody>
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

function Page() {
  const { pageTree, path } = useFumadocsLoader(Route.useLoaderData());

  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
      <Suspense>{clientLoader.useContent(path)}</Suspense>
    </DocsLayout>
  );
}
