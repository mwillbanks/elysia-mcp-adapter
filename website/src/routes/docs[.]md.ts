import { createFileRoute } from "@tanstack/react-router";
import { pageMarkdownResponse } from "@/lib/llm";
import { source } from "@/lib/source";

export const Route = createFileRoute("/docs.md")({
  server: {
    handlers: {
      GET: async () => pageMarkdownResponse(source.getPage([]), import.meta.env.BASE_URL),
    },
  },
});
