import logoUrl from "../../../logo.svg?url";

type BrandProps = {
  compact?: boolean;
};

export function Brand({ compact = false }: BrandProps) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <img alt="Elysia MCP Adapter" className={compact ? "size-8" : "size-10"} src={logoUrl} />
      <span className="flex flex-col leading-none">
        <span className="font-semibold tracking-[-0.03em] text-fd-foreground">
          elysia-mcp-adapter
        </span>
        {!compact && (
          <span className="mt-1 text-[0.62rem] font-medium uppercase tracking-[0.16em] text-fd-muted-foreground">
            routes become protocol
          </span>
        )}
      </span>
    </span>
  );
}
