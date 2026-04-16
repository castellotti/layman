import { useState, useEffect } from 'react';

export interface ChangelogEntry {
  markdown: string;
  sourceUrl: string;
  fetchedAt: number;
}

// Module-level cache: agentType → entry (10-minute TTL)
const cache = new Map<string, ChangelogEntry>();
const TTL_MS = 10 * 60 * 1000;

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
}

const CHANGELOG_CONFIG: Record<string, { rawUrl: string; sourceUrl: string; useGithubReleases?: string }> = {
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
    rawUrl: '',
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

async function fetchChangelog(agentType: string): Promise<ChangelogEntry> {
  const cached = cache.get(agentType);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;

  const config = CHANGELOG_CONFIG[agentType];
  if (!config) throw new Error(`No changelog configured for ${agentType}`);

  let markdown: string;
  if (config.useGithubReleases) {
    markdown = await fetchGithubReleases(config.useGithubReleases);
  } else {
    const res = await fetch(config.rawUrl);
    if (!res.ok) throw new Error(`Fetch error: ${res.status}`);
    markdown = await res.text();
  }

  const entry: ChangelogEntry = { markdown, sourceUrl: config.sourceUrl, fetchedAt: Date.now() };
  cache.set(agentType, entry);
  return entry;
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
