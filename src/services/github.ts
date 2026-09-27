import { AppError } from '../lib/errors.js';
import { log } from '../lib/log.js';

/** Minimal GitHub REST client. The token comes from the environment and is never stored. */
export class GitHubClient {
  constructor(
    private readonly token: string | null,
    private readonly apiUrl = 'https://api.github.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return this.token !== null;
  }

  async request<T>(method: string, path: string, body?: unknown, token = this.token): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'sbox-collaborator-server',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new AppError('unavailable', `GitHub is unreachable: ${(error as Error).message}`);
    }
    if (response.status === 404) throw new AppError('not_found', `GitHub: ${path} not found (or the server's GitHub token has no access)`);
    if (response.status === 401 || response.status === 403) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const message = remaining === '0' ? 'GitHub rate limit reached; set GITHUB_TOKEN on the server' : 'GitHub refused the request; check the server GITHUB_TOKEN permissions';
      throw new AppError('unavailable', message);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      log.warn('github request failed', { method, path, status: response.status, body: text.slice(0, 300) });
      throw new AppError('unavailable', `GitHub returned ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }

  requireToken(action: string): void {
    if (!this.token) throw new AppError('unavailable', `${action} needs GITHUB_TOKEN on the server.`);
  }

  getCommit(repo: string, sha: string) {
    return this.request<GhCommitDetail>('GET', `/repos/${repo}/commits/${encodeURIComponent(sha)}`);
  }

  listCommits(repo: string, options: { branch?: string; perPage?: number } = {}) {
    const params = new URLSearchParams({ per_page: String(options.perPage ?? 20) });
    if (options.branch) params.set('sha', options.branch);
    return this.request<GhCommitSummary[]>('GET', `/repos/${repo}/commits?${params}`);
  }

  compare(repo: string, base: string, head: string) {
    return this.request<GhCompare>('GET', `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  }

  listIssues(repo: string, state: 'open' | 'closed' | 'all', perPage = 30) {
    return this.request<GhIssue[]>('GET', `/repos/${repo}/issues?state=${state}&per_page=${perPage}&sort=updated`);
  }

  listPulls(repo: string, state: 'open' | 'closed' | 'all', perPage = 30) {
    return this.request<GhPull[]>('GET', `/repos/${repo}/pulls?state=${state}&per_page=${perPage}&sort=updated&direction=desc`);
  }

  createIssue(repo: string, input: { title: string; body?: string; labels?: string[] }) {
    this.requireToken('Creating GitHub issues');
    return this.request<GhIssue>('POST', `/repos/${repo}/issues`, input);
  }

  getRepo(repo: string) {
    return this.request<{ full_name: string; default_branch: string; private: boolean }>('GET', `/repos/${repo}`);
  }

  // ---- OAuth (login) -------------------------------------------------------------------

  async exchangeOAuthCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<string> {
    const response = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'sbox-collaborator-server' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!response.ok || !data.access_token) throw new AppError('unauthorized', `GitHub login failed: ${data.error_description ?? response.status}`);
    return data.access_token;
  }

  /** The GitHub user behind an OAuth token. The token is used once and discarded. */
  getAuthenticatedUser(accessToken: string) {
    return this.request<{ id: number; login: string; name: string | null; avatar_url: string }>('GET', '/user', undefined, accessToken);
  }
}

export interface GhCommitSummary {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: { login: string } | null;
}

export interface GhCommitDetail extends GhCommitSummary {
  stats?: { additions: number; deletions: number; total: number };
  files?: { filename: string; status: string; additions: number; deletions: number; previous_filename?: string }[];
}

export interface GhCompare {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: GhCommitSummary[];
  files?: { filename: string; status: string; additions: number; deletions: number; previous_filename?: string }[];
}

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string } | null;
  labels: ({ name: string } | string)[];
  updated_at: string;
  pull_request?: unknown;
}

export interface GhPull {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
  merged_at: string | null;
  updated_at: string;
  draft?: boolean;
}
