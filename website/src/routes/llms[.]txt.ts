import { createFileRoute } from "@tanstack/react-router";
import { llms } from "fumadocs-core/source/llms";
import { textResponse, withBasePathInMarkdown } from "@/lib/llm";
import { source } from "@/lib/source";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () =>
        textResponse(
          withBasePathInMarkdown(llms(source).index(), import.meta.env.BASE_URL),
          "text/plain",
        ),
    },
  },
});
