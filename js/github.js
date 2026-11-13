// Minimal GitHub REST client for storing encrypted files in a private repository.

const API = 'https://api.github.com';
export const DATA_ROOT = 'pace';

export class GitHubError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseRepo(input) {
  const s = String(input || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export class GitHubStore {
  constructor({ token, owner, repo }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  async request(method, path, body, accept = 'application/vnd.github+json') {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        cache: 'no-store',
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError('Can’t reach GitHub. Check your connection.', 0, 'OFFLINE');
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
      if (res.status === 401) throw new GitHubError('GitHub rejected the access token. It may be expired or mistyped.', 401, 'BAD_TOKEN');
      if (res.status === 403 && /rate limit/i.test(msg)) throw new GitHubError('GitHub rate limit reached. Try again in a few minutes.', 403, 'RATE_LIMIT');
      if (res.status === 403) throw new GitHubError('This token can’t write to that repository. Give it “Contents: Read and write” access.', 403, 'FORBIDDEN');
      if (res.status === 409 || (res.status === 422 && /sha/i.test(msg))) throw new GitHubError('Remote changed', res.status, 'CONFLICT');
      throw new GitHubError(msg || `GitHub error ${res.status}`, res.status, 'HTTP');
    }
    if (res.status === 204) return {};
    return accept.includes('raw') ? res.text() : res.json();
  }

  /** Verifies the token and that the repo exists and is private. */
  async checkRepo() {
    const repo = await this.request('GET', `/repos/${this.owner}/${this.repo}`);
    if (!repo) {
      throw new GitHubError(`Repository ${this.owner}/${this.repo} wasn’t found, or the token can’t see it.`, 404, 'NO_REPO');
    }
    if (!repo.private) {
      throw new GitHubError(`${this.owner}/${this.repo} is public. Pace only stores data in a private repository.`, 400, 'PUBLIC_REPO');
    }
    if (repo.permissions && !repo.permissions.push) {
      throw new GitHubError('This token can read the repository but can’t write to it. Give it “Contents: Read and write” access.', 403, 'FORBIDDEN');
    }
    return repo;
  }

  path(p) {
    return `/repos/${this.owner}/${this.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Returns { content, sha } or null when the file doesn't exist. */
  async getFile(p) {
    const meta = await this.request('GET', this.path(p));
    if (!meta) return null;
    if (meta.encoding === 'base64' && meta.content) {
      return { content: atob(meta.content.replace(/\n/g, '')), sha: meta.sha };
    }
    // Files over 1 MB come back without inline content.
    const content = await this.request('GET', this.path(p), null, 'application/vnd.github.raw+json');
    return { content, sha: meta.sha };
  }

  /** Content must be ASCII (our blobs are base64). Returns the new sha. */
  async putFile(p, content, sha, message = 'Update') {
    const res = await this.request('PUT', this.path(p), {
      message,
      content: btoa(content),
      ...(sha ? { sha } : {}),
    });
    return res.content.sha;
  }
}
