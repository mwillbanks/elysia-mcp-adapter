import { createFileRoute } from "@tanstack/react-router";
import { pageMarkdownResponse } from "@/lib/llm";
import { source } from "@/lib/source";

export const Route = createFileRoute("/docs/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slugs = params._splat?.split("/") ?? [];
        return pageMarkdownResponse(source.getPage(slugs), import.meta.env.BASE_URL);
      },
    },
  },
});
