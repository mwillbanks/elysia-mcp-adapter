"use client";

import { useDocsSearch } from "fumadocs-core/search/client";
import { staticClient } from "fumadocs-core/search/client/orama-static";
import { create } from "zbsearch";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";

const searchEndpoint = `${import.meta.env.BASE_URL}api/search`;

function initDB() {
  return create({
    language: "english",
    schema: { _: "string" },
  });
}

export default function StaticSearchDialog(props: SharedProps) {
  const { query, search, setSearch } = useDocsSearch({
    client: staticClient({
      from: searchEndpoint,
      initDB,
    }),
  });

  return (
    <SearchDialog isLoading={query.isLoading} onSearchChange={setSearch} search={search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== "empty" ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  );
}
