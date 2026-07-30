import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Braces,
  GitBranch,
  Route as RouteIcon,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Brand } from "@/components/brand";
import { baseOptions } from "@/lib/layout.shared";

export const Route = createFileRoute("/")({ component: Home });

const highlights = [
  {
    description:
      "Every route-backed call travels through Elysia parsing, validation, hooks, guards, and response mapping.",
    icon: GitBranch,
    title: "Elysia stays in control",
  },
  {
    description:
      "Turn HTTP routes into tools by default, then opt resources and prompts into the same focused registry.",
    icon: Workflow,
    title: "One protocol gateway",
  },
  {
    description:
      "Origin checks, denied model headers, credential redaction, and binary limits ship as the baseline.",
    icon: ShieldCheck,
    title: "Secure defaults",
  },
];

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="home-shell flex-1 overflow-hidden">
        <section className="relative mx-auto grid max-w-[90rem] grid-cols-[minmax(0,1fr)] gap-12 px-6 pb-20 pt-20 lg:grid-cols-[1.08fr_0.92fr] lg:px-12 lg:pb-28 lg:pt-28">
          <div className="hero-glow" aria-hidden="true" />
          <div className="relative z-10 min-w-0">
            <div className="mb-8 inline-flex rounded-full border border-violet-500/20 bg-violet-500/8 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-violet-700 dark:text-violet-300">
              Elysia × Model Context Protocol
            </div>
            <div className="mb-8 lg:hidden">
              <Brand />
            </div>
            <h1 className="max-w-4xl text-balance text-5xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-7xl lg:text-[5.35rem]">
              Your routes,
              <span className="hero-gradient block">protocol-ready.</span>
            </h1>
            <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground sm:text-xl">
              Expose existing Elysia APIs as MCP tools without bypassing the framework behavior that
              makes them production-ready.
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Link
                className="group inline-flex items-center justify-center gap-2 rounded-full bg-fd-primary px-6 py-3 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-violet-500/10 transition hover:-translate-y-0.5 hover:shadow-violet-500/20"
                params={{ _splat: "getting-started/quick-start" }}
                to="/docs/$"
              >
                Get started
                <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
              </Link>
              <a
                className="inline-flex items-center justify-center gap-2 rounded-full border border-fd-border bg-fd-card/70 px-6 py-3 text-sm font-semibold backdrop-blur transition hover:border-violet-500/40 hover:bg-fd-accent"
                href="https://github.com/mwillbanks/elysia-mcp-adapter"
              >
                View on GitHub
              </a>
            </div>
          </div>

          <div className="relative z-10 flex min-w-0 items-center">
            <div className="code-window w-full overflow-hidden rounded-3xl border border-fd-border/80 bg-zinc-950 shadow-2xl shadow-violet-950/25">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3 text-xs text-zinc-400">
                <span className="flex gap-1.5" aria-hidden="true">
                  <span className="size-2.5 rounded-full bg-rose-400/80" />
                  <span className="size-2.5 rounded-full bg-amber-300/80" />
                  <span className="size-2.5 rounded-full bg-cyan-400/80" />
                </span>
                server.ts
              </div>
              <pre className="overflow-x-auto p-6 text-[0.82rem] leading-7 text-zinc-300 sm:p-8 sm:text-sm">
                <code>
                  {[
                    "import { mcp } from",
                    '  "@mwillbanks/elysia-mcp-adapter"',
                    'import { Elysia, t } from "elysia"',
                    "",
                    "new Elysia()",
                    "  .use(mcp())",
                    '  .get("/users/:id",',
                    "    ({ params }) => params,",
                    "    {",
                    "      params: t.Object({",
                    "        id: t.String(),",
                    "      }),",
                    "      detail: {",
                    '        operationId: "users.get",',
                    "      },",
                    "    },",
                    "  )",
                    "  .listen(3000)",
                  ].join("\n")}
                </code>
              </pre>
            </div>
          </div>
        </section>

        <section className="border-y border-fd-border/70 bg-fd-card/35">
          <div className="mx-auto grid max-w-[90rem] gap-px px-6 py-6 md:grid-cols-3 lg:px-12">
            {highlights.map(({ description, icon: Icon, title }) => (
              <article className="feature-card p-6 sm:p-8" key={title}>
                <Icon className="mb-5 size-6 text-violet-600 dark:text-violet-400" />
                <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
                <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-[90rem] px-6 py-20 lg:px-12 lg:py-28">
          <div className="mb-12 flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <p className="mb-3 text-sm font-semibold text-violet-700 dark:text-violet-300">
                Choose your path
              </p>
              <h2 className="max-w-2xl text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">
                From first route to a deliberate MCP surface.
              </h2>
            </div>
            <p className="max-w-md text-sm leading-6 text-fd-muted-foreground">
              Start with automatic route tools, add protocol-native primitives, then narrow and
              harden the surface for production.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <JourneyCard
              icon={Sparkles}
              label="01 / Start"
              slug="getting-started/quick-start"
              text="Install the adapter and expose your first typed Elysia route."
              title="Quick Start"
            />
            <JourneyCard
              icon={RouteIcon}
              label="02 / Shape"
              slug="core-concepts/route-backed-tools"
              text="Control naming, schemas, inputs, route selection, and metadata."
              title="Route-backed tools"
            />
            <JourneyCard
              icon={Braces}
              label="03 / Extend"
              slug="core-concepts/resources-and-prompts"
              text="Add standalone tools, URI resources, templates, and reusable prompts."
              title="MCP primitives"
            />
          </div>
        </section>
      </main>
    </HomeLayout>
  );
}

type JourneyCardProps = {
  icon: typeof Sparkles;
  label: string;
  slug: string;
  text: string;
  title: string;
};

function JourneyCard({ icon: Icon, label, slug, text, title }: JourneyCardProps) {
  return (
    <Link
      className="journey-card group rounded-2xl border border-fd-border bg-fd-card p-6 transition hover:-translate-y-1 hover:border-violet-500/40 hover:shadow-xl hover:shadow-violet-950/5"
      params={{ _splat: slug }}
      to="/docs/$"
    >
      <div className="flex items-start justify-between">
        <span className="font-mono text-xs text-fd-muted-foreground">{label}</span>
        <Icon className="size-5 text-violet-600 dark:text-violet-400" />
      </div>
      <h3 className="mt-10 text-xl font-semibold tracking-tight">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">{text}</p>
      <span className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
        Read guide
        <ArrowRight className="size-4 transition group-hover:translate-x-1" />
      </span>
    </Link>
  );
}
