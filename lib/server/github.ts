import "server-only";
import { MAX_ARCHIVE_BYTES } from "@/lib/engines/zip";

/** Only github.com repository URLs are accepted; the fetch host is fixed (no SSRF via user URLs). */
const GITHUB_REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/tree\/([A-Za-z0-9._\/-]{1,200}))?\/?$/;
const FETCH_TIMEOUT_MS = 30_000;

export type GithubRepoRef = { owner: string; repo: string; ref?: string };

export function parseGithubUrl(url: string): GithubRepoRef {
  const match = GITHUB_REPO_URL.exec(url.trim());
  if (!match) throw new Error("Expected a public repository URL like https://github.com/owner/repo (optionally /tree/<branch>).");
  return { owner: match[1]!, repo: match[2]!, ref: match[3] };
}

export async function downloadRepoArchive({ owner, repo, ref }: GithubRepoRef): Promise<ArrayBuffer> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball${ref ? `/${ref.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  const headers: Record<string, string> = { "User-Agent": "codearchitect-ai", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(`https://api.github.com${path}`, { headers, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status === 404) throw new Error(`Repository ${owner}/${repo} not found or not public.`);
  if (response.status === 403 || response.status === 429) throw new Error("GitHub rate limit reached; set GITHUB_TOKEN or try later.");
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${owner}/${repo}.`);

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error(`Repository archive exceeds ${MAX_ARCHIVE_BYTES / 1e6} MB.`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) throw new Error(`Repository archive exceeds ${MAX_ARCHIVE_BYTES / 1e6} MB.`);
  return buffer;
}
