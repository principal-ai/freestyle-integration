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
  /** What we expect this run to show, from prior investigation. */
  expect: 'populates' | 'INTERNAL_ERROR';
  /** Rough scale, for context in the report. */
  note?: string;
}

export const DEFAULT_REPOS: RepoSpec[] = [
  // --- our own repos (under test) ---
  { owner: 'principal-ai', repo: 'alexandria-core-library', rev: 'main', expect: 'populates', note: 'principal-ai org, public, ~0.8 MB' },
  { owner: 'principal-ai', repo: 'strategy-planning', rev: 'main', expect: 'populates', note: 'principal-ai org, private, ~16 MB' },
  // --- import OK (small → large) ---
  { owner: 'sindresorhus', repo: 'yocto-queue', rev: 'main', expect: 'populates', note: 'tiny' },
  { owner: 'expressjs', repo: 'express', rev: 'master', expect: 'populates', note: '~9.8 MB' },
  { owner: 'pierrecomputer', repo: 'pierre', rev: 'main', expect: 'populates', note: '~60 MB' },
  { owner: 'facebook', repo: 'react', rev: 'main', expect: 'populates', note: 'large — rules out size alone' },
  // --- import FAILS via source (never populates) ---
  { owner: 'anomalyco', repo: 'opencode', rev: 'dev', expect: 'INTERNAL_ERROR', note: '~283 MB, default branch dev' },
  { owner: 'pingdotgg', repo: 't3code', rev: 'main', expect: 'INTERNAL_ERROR', note: '~178 MB' },
];

/** Parse an `owner/repo` or `owner/repo@rev` CLI token into a RepoSpec. */
export function parseRepoArg(token: string): RepoSpec {
  const [slug, rev] = token.split('@');
  const [owner, repo] = (slug ?? '').split('/');
  if (!owner || !repo) {
    throw new Error(`bad --repo "${token}" — expected owner/repo or owner/repo@rev`);
  }
  return { owner, repo, rev: rev ?? null, expect: 'populates' };
}
