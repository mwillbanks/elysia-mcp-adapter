import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Brand } from "@/components/brand";
import { GithubInfo } from "fumadocs-ui/components/github-info";
import { gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      {
        type: "custom",
        children: <GithubInfo owner={gitConfig.user} repo={gitConfig.repo} />,
      },
    ],
    nav: { title: <Brand compact /> },
  };
}
