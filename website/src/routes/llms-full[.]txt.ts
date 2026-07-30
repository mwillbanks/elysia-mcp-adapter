import { createFileRoute } from "@tanstack/react-router";
import { getLLMFullText, textResponse } from "@/lib/llm";
import { source } from "@/lib/source";

export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: async () =>
        textResponse(
          await getLLMFullText(source.getPages(), import.meta.env.BASE_URL),
          "text/plain",
        ),
    },
  },
});
