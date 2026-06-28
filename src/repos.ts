/**
 * The default repro set — the exact repos from the investigation, with their
 * observed import outcome via the production `source` path. Running with no
 * `--repo` flag exercises all of these so the contrast (good vs failing) shows
 * up in one table.
 */

export interface RepoSpec {
  owner: string;
  repo: string;
  /**
   * Revision to import — Freestyle's documented `source.rev` field (a branch
   * name, tag, or sha). null → Freestyle picks the repo's default branch.
   */
  rev: string | null;
  /**
   * Whether we expect this repo to *succeed* for the selected use case (import
   * populates / VM exec returns output). A run flags any repo whose observed
   * outcome contradicts this. Use-case-specific status detail (e.g. the exact
   * `INTERNAL_ERROR` code) shows up in the result, not here.
   */
  expectOk: boolean;
  /** Rough scale, for context in the report. */
  note?: string;
}

export const DEFAULT_REPOS: RepoSpec[] = [
  // --- our own repos (under test) ---
  { owner: 'principal-ai', repo: 'alexandria-core-library', rev: 'main', expectOk: true, note: 'principal-ai org, public, ~0.8 MB' },
  { owner: 'principal-ai', repo: 'strategy-planning', rev: 'main', expectOk: true, note: 'principal-ai org, private, ~16 MB' },
  // --- import OK (small → large) ---
  { owner: 'sindresorhus', repo: 'yocto-queue', rev: 'main', expectOk: true, note: 'tiny' },
  { owner: 'expressjs', repo: 'express', rev: 'master', expectOk: true, note: '~9.8 MB' },
  { owner: 'pierrecomputer', repo: 'pierre', rev: 'main', expectOk: true, note: '~60 MB' },
  { owner: 'facebook', repo: 'react', rev: 'main', expectOk: true, note: 'large — rules out size alone' },
  // --- import FAILS via source (never populates) ---
  { owner: 'anomalyco', repo: 'opencode', rev: 'dev', expectOk: false, note: '~283 MB, default branch dev' },
  { owner: 'pingdotgg', repo: 't3code', rev: 'main', expectOk: false, note: '~178 MB' },
];

/**
 * Parse a repo token into a RepoSpec. Accepts, in order of convenience:
 *   - `owner/repo`               (rev = default branch)
 *   - `owner/repo@rev`           (explicit branch/tag/sha)
 *   - `https://github.com/owner/repo[.git]`        (full URL)
 *   - `https://github.com/owner/repo/tree/<branch>` (URL → rev)
 */
export function parseRepoArg(token: string): RepoSpec {
  // Strip a GitHub URL prefix and a trailing `.git` so URLs and slugs converge.
  let t = token
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '');

  // `…/owner/repo/tree/<branch>` (or `/blob/<branch>`) → pull the rev out.
  const tree = t.match(/^([^/]+)\/([^/]+)\/(?:tree|blob)\/(.+)$/);
  if (tree) {
    return { owner: tree[1], repo: tree[2], rev: decodeURIComponent(tree[3]), expectOk: true };
  }

  let rev: string | null = null;
  if (t.includes('@')) {
    const [slug, r] = t.split('@');
    t = slug ?? '';
    rev = r ?? null;
  }
  const [owner, repo] = t.replace(/\/+$/, '').split('/');
  if (!owner || !repo) {
    throw new Error(
      `bad repo "${token}" — expected owner/repo, owner/repo@rev, or a github.com URL`
    );
  }
  return { owner, repo, rev: rev ?? null, expectOk: true };
}
