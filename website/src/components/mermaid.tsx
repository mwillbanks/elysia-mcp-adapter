// biome-ignore-all lint/security/noDangerouslySetInnerHtml: SVG is generated from repository-authored Mermaid, not user input.
import { renderMermaidSVG } from "beautiful-mermaid";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";

export interface MermaidProps {
  chart: string;
  title: string;
}

export function Mermaid({ chart, title }: MermaidProps) {
  try {
    const svg = renderMermaidSVG(chart.trim(), {
      accent: "var(--color-fd-primary)",
      bg: "var(--color-fd-card)",
      border: "var(--color-fd-border)",
      fg: "var(--color-fd-foreground)",
      line: "var(--color-fd-muted-foreground)",
      muted: "var(--color-fd-muted-foreground)",
      surface: "var(--color-fd-secondary)",
      transparent: true,
    });

    return (
      <figure className="my-8 overflow-x-auto rounded-2xl border bg-fd-card/60 p-4 shadow-sm sm:p-6">
        <div
          aria-label={title}
          className="min-w-[36rem] [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
          role="img"
        />
        <figcaption className="mt-4 text-center text-sm text-fd-muted-foreground">
          {title}
        </figcaption>
      </figure>
    );
  } catch {
    return (
      <CodeBlock title={title}>
        <Pre>{chart}</Pre>
      </CodeBlock>
    );
  }
}
