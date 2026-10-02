import { GitFork, Star } from "lucide-react";
import { use } from "react";

interface RepositoryStats {
  forks: number;
  stars: number;
}

interface GithubRepositoryInfoProps {
  owner: string;
  repo: string;
  token?: string;
}

const requests = new Map<string, Promise<RepositoryStats | null>>();
const formatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  notation: "compact",
});

export async function fetchGithubRepositoryStats(
  owner: string,
  repo: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepositoryStats | null> {
  try {
    const headers = new Headers({ Accept: "application/vnd.github+json" });
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!response.ok) return null;

    const data: unknown = await response.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("stargazers_count" in data) ||
      !("forks_count" in data) ||
      typeof data.stargazers_count !== "number" ||
      typeof data.forks_count !== "number"
    ) {
      return null;
    }

    return { forks: data.forks_count, stars: data.stargazers_count };
  } catch {
    return null;
  }
}

function getRepositoryStats(owner: string, repo: string, token?: string) {
  const key = `${owner}/${repo}`;
  const existing = requests.get(key);
  if (existing) return existing;

  const request = fetchGithubRepositoryStats(owner, repo, token);
  requests.set(key, request);
  return request;
}

export function GithubRepositoryInfo({ owner, repo, token }: GithubRepositoryInfoProps) {
  const stats = use(getRepositoryStats(owner, repo, token));

  return (
    <a
      className="flex flex-col gap-1.5 rounded-lg p-2 text-sm text-fd-foreground/80 transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
      href={`https://github.com/${owner}/${repo}`}
      rel="noreferrer noopener"
      target="_blank"
    >
      <p className="flex items-center gap-2 truncate">
        <svg aria-hidden="true" className="size-3.5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z" />
        </svg>
        {owner}/{repo}
      </p>
      {stats ? (
        <div className="flex items-center gap-1 text-xs text-fd-muted-foreground">
          <Star className="size-3" />
          <span>{formatter.format(stats.stars)}</span>
          <GitFork className="ms-2 size-3" />
          <span>{formatter.format(stats.forks)}</span>
        </div>
      ) : null}
    </a>
  );
}
