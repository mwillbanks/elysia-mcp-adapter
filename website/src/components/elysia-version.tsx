import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "fumadocs-ui/components/ui/tabs";
import {
  readElysiaVersion,
  saveElysiaVersion,
  type ElysiaVersion as Version,
} from "../lib/elysia-version";

const VersionContext = createContext<{
  version: Version;
  selectVersion: (version: Version) => void;
}>({ version: "1", selectVersion: () => {} });

export function ElysiaVersionProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState<Version>("1");

  useEffect(() => {
    try {
      setVersion(readElysiaVersion(window.localStorage));
    } catch {
      // Browsers can deny access to the storage object itself.
    }
  }, []);

  return (
    <VersionContext
      value={{
        version,
        selectVersion(next) {
          setVersion(next);
          try {
            saveElysiaVersion(window.localStorage, next);
          } catch {
            // Keep the selected version when browser storage is unavailable.
          }
        },
      }}
    >
      {children}
    </VersionContext>
  );
}

export function ElysiaVersionSelector() {
  const { version, selectVersion } = useContext(VersionContext);
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      Elysia version
      <select
        id={id}
        value={version}
        onChange={(event) => selectVersion(event.target.value === "2" ? "2" : "1")}
        className="rounded-md border bg-fd-background px-2 py-1 text-fd-foreground"
      >
        <option value="1">Elysia 1</option>
        <option value="2">Elysia 2</option>
      </select>
    </label>
  );
}

export function ElysiaVersions({ children }: { children: ReactNode }) {
  const { version } = useContext(VersionContext);
  return (
    <ExampleTabs key={version} defaultVersion={version}>
      {children}
    </ExampleTabs>
  );
}

function ExampleTabs({
  defaultVersion,
  children,
}: {
  defaultVersion: Version;
  children: ReactNode;
}) {
  const [version, setVersion] = useState<Version>(defaultVersion);
  return (
    <Tabs value={version} onValueChange={(value) => setVersion(value === "2" ? "2" : "1")}>
      <TabsList aria-label="Elysia example version">
        <TabsTrigger value="1">Elysia 1</TabsTrigger>
        <TabsTrigger value="2">Elysia 2</TabsTrigger>
      </TabsList>
      {children}
    </Tabs>
  );
}

export function ElysiaVersion({ value, children }: { value: Version; children: ReactNode }) {
  return <TabsContent value={value}>{children}</TabsContent>;
}
