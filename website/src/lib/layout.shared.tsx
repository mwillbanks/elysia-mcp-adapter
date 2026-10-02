import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Brand } from "@/components/brand";
import { GithubRepositoryInfo } from "@/components/github-repository-info";
import { gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  const githubToken = import.meta.env.SSR ? process.env.GITHUB_TOKEN : undefined;
  return {
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      {
        type: "custom",
        children: (
          <GithubRepositoryInfo owner={gitConfig.user} repo={gitConfig.repo} token={githubToken} />
        ),
      },
    ],
    nav: { title: <Brand compact /> },
  };
}
