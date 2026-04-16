import { useState, useEffect } from 'react';

export interface ChangelogEntry {
  markdown: string;
  sourceUrl: string;
  fetchedAt: number;
}

export const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'mistral-vibe': 'Mistral Vibe',
  cline: 'Cline',
  codex: 'Codex',
  opencode: 'OpenCode',
};

// Module-level cache: agentType → entry (10-minute TTL)
const cache = new Map<string, ChangelogEntry>();
const TTL_MS = 10 * 60 * 1000;

// In-flight promise map prevents duplicate fetches when the modal is opened
// before a prior fetch has settled.
const inflight = new Map<string, Promise<ChangelogEntry>>();

interface GitHubRelease {
  tag_name: string;
  body: string;
  published_at: string;
  html_url: string;
}

const CHANGELOG_CONFIG: Record<string, { rawUrl?: string; sourceUrl: string; useGithubReleases?: string }> = {
  'claude-code': {
    rawUrl: 'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md',
    sourceUrl: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
  },
  'mistral-vibe': {
    rawUrl: 'https://raw.githubusercontent.com/mistralai/mistral-vibe/refs/heads/main/CHANGELOG.md',
    sourceUrl: 'https://github.com/mistralai/mistral-vibe/blob/main/CHANGELOG.md',
  },
  cline: {
    rawUrl: 'https://raw.githubusercontent.com/cline/cline/refs/heads/main/CHANGELOG.md',
    sourceUrl: 'https://github.com/cline/cline/blob/main/CHANGELOG.md',
  },
  codex: {
    // Uses GitHub Releases API (unauthenticated: 60 req/hour per IP).
    // The 10-min module cache means at most 6 fetches/hour in normal use.
    sourceUrl: 'https://github.com/openai/codex/releases',
    useGithubReleases: 'openai/codex',
  },
};

async function fetchGithubReleases(repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const releases = (await res.json()) as GitHubRelease[];
  return releases
    .map((r) => {
      const date = r.published_at ? r.published_at.slice(0, 10) : '';
      const header = `## ${r.tag_name}${date ? ` — ${date}` : ''}`;
      const body = r.body?.trim() ?? '_No release notes._';
      return `${header}\n\n${body}`;
    })
    .join('\n\n---\n\n');
}

async function doFetch(agentType: string): Promise<ChangelogEntry> {
  const config = CHANGELOG_CONFIG[agentType];
  if (!config) throw new Error(`No changelog configured for ${agentType}`);

  let markdown: string;
  if (config.useGithubReleases) {
    markdown = await fetchGithubReleases(config.useGithubReleases);
  } else if (config.rawUrl) {
    const res = await fetch(config.rawUrl);
    if (!res.ok) throw new Error(`Fetch error: ${res.status}`);
    markdown = await res.text();
  } else {
    throw new Error(`No fetch URL configured for ${agentType}`);
  }

  const entry: ChangelogEntry = { markdown, sourceUrl: config.sourceUrl, fetchedAt: Date.now() };
  cache.set(agentType, entry);
  return entry;
}

async function fetchChangelog(agentType: string): Promise<ChangelogEntry> {
  const cached = cache.get(agentType);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;

  const existing = inflight.get(agentType);
  if (existing) return existing;

  const p = doFetch(agentType).finally(() => inflight.delete(agentType));
  inflight.set(agentType, p);
  return p;
}

export function hasChangelog(agentType: string): boolean {
  return agentType in CHANGELOG_CONFIG;
}

export function useChangelog(agentType: string | null) {
  const [state, setState] = useState<{
    loading: boolean;
    markdown: string | null;
    sourceUrl: string | null;
    error: string | null;
  }>({ loading: false, markdown: null, sourceUrl: null, error: null });

  useEffect(() => {
    if (!agentType || !hasChangelog(agentType)) {
      setState({ loading: false, markdown: null, sourceUrl: null, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    fetchChangelog(agentType)
      .then((entry) => {
        if (!cancelled) setState({ loading: false, markdown: entry.markdown, sourceUrl: entry.sourceUrl, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ loading: false, markdown: null, sourceUrl: null, error: String(err) });
      });

    return () => { cancelled = true; };
  }, [agentType]);

  return state;
}
