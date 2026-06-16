/**
 * The per-repo probe — pure Freestyle SDK, no VM, no git binary.
 *
 * Reproduces what hosted trail authoring does at the point of failure, using
 * Freestyle's EXACTLY documented source-import call shape
 * (https://www.freestyle.sh/docs/git/repositories):
 *
 *     await freestyle.git.repos.create({
 *       source: { url: "https://github.com/user/repo.git", rev: "main" },
 *     });
 *
 * i.e. the documented `rev` field and a `.git` URL, with no undocumented
 * `branch`/`depth` options — so the evidence can't be dismissed as misuse.
 *
 *   1. `git.repos.create({ source: { url, rev } })` — server-side import of a
 *      GitHub repo into a fresh Freestyle Git repo. Returns a `repoId`
 *      immediately; population is asynchronous on Freestyle's side.
 *   2. Poll `git.repos.ref({ repoId }).branches.list()` until the repo is
 *      readable (populated) or the window elapses. For the failing repos this
 *      call returns `INTERNAL_ERROR` for the entire window — the repo never
 *      populates — and the SDK error carries a fresh `traceId`.
 *   3. Tear the Freestyle repo down regardless of outcome.
 *
 * `branches.list()` is the same readiness signal a VM clone depends on: while it
 * returns INTERNAL_ERROR, `git clone git.freestyle.sh/{repoId}` returns HTTP 500.
 */
import { freestyle } from 'freestyle';
import type { RepoSpec } from './repos.js';

export interface ProbeResult {
  slug: string; // owner/repo
  rev: string | null;
  expect: RepoSpec['expect'];
  note?: string;
  /** ms for `git.repos.create` to return a repoId. */
  createMs: number | null;
  repoId: string | null;
  /** Did `branches.list()` ever succeed within the window? */
  populated: boolean;
  /** ms from create→first successful branches.list (when populated). */
  populateMs: number | null;
  /** Number of branches.list() attempts made. */
  attempts: number;
  /** Last error surfaced by branches.list(), when it never populated. */
  errorCode: string | null;
  errorMessage: string | null;
  /** Underlying transport cause for a client-side `fetch failed`, if any. */
  errorCause: string | null;
  traceId: string | null;
  /** Whether the repo was successfully deleted in teardown. */
  tornDown: boolean;
  /** A fatal error before/at create (e.g. auth) — repro couldn't run. */
  fatal: string | null;
}

interface ExtractedError {
  code: string | null;
  message: string;
  traceId: string | null;
  statusCode: number | null;
  name: string | null;
  /**
   * For a `TypeError: fetch failed` the real reason lives in `error.cause`
   * (e.g. `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_CONNECT_TIMEOUT`, `ECONNRESET`) —
   * these are Node's undici defaults, since neither this harness nor the SDK
   * sets a fetch timeout. Capture it so a transport failure is diagnosable.
   */
  cause: string | null;
}

/** Pull the structured fields off a thrown Freestyle SDK error. */
function extractError(e: unknown): ExtractedError {
  const err = e as {
    body?: { code?: string; message?: string };
    traceId?: string;
    name?: string;
    message?: string;
    cause?: unknown;
    constructor?: { code?: string; statusCode?: number };
  };
  const rawCause = err?.cause as { code?: string; message?: string } | undefined;
  const cause = rawCause
    ? rawCause.code ?? rawCause.message ?? String(rawCause)
    : null;
  return {
    code: err?.body?.code ?? err?.constructor?.code ?? null,
    message:
      err?.body?.message ?? (e instanceof Error ? e.message : String(e)),
    traceId: err?.traceId ?? null,
    statusCode: err?.constructor?.statusCode ?? null,
    name: err?.name ?? null,
    cause,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface ProbeOptions {
  /** Total seconds to poll branches.list() before declaring "never populated". */
  windowSecs: number;
  /** Seconds between branches.list() polls. */
  intervalSecs: number;
  /** Skip teardown (leave the Freestyle repo for manual inspection). */
  noTeardown: boolean;
  githubToken: string | undefined;
  onLog: (msg: string) => void;
}

export async function probeRepo(
  spec: RepoSpec,
  opts: ProbeOptions
): Promise<ProbeResult> {
  const slug = `${spec.owner}/${spec.repo}`;
  const result: ProbeResult = {
    slug,
    rev: spec.rev,
    expect: spec.expect,
    note: spec.note,
    createMs: null,
    repoId: null,
    populated: false,
    populateMs: null,
    attempts: 0,
    errorCode: null,
    errorMessage: null,
    errorCause: null,
    traceId: null,
    tornDown: false,
    fatal: null,
  };

  // Documented source URL shape: https://github.com/owner/repo.git — token
  // embedded host-side so Freestyle can fetch private repos; for public repos it
  // just lifts the GitHub rate limit. (No token → anonymous fetch, fine for
  // public repos.)
  const auth = opts.githubToken ? `x-access-token:${opts.githubToken}@` : '';
  const url = `https://${auth}github.com/${spec.owner}/${spec.repo}.git`;

  // 1. Create — Freestyle's documented call: `source: { url, rev }`, nothing
  //    undocumented (no `branch`, no `depth`).
  const tCreate = Date.now();
  try {
    const { repoId } = await freestyle.git.repos.create({
      name: `repro-${spec.owner}-${spec.repo}-${tCreate}`,
      source: { url, rev: spec.rev },
    });
    result.createMs = Date.now() - tCreate;
    result.repoId = repoId;
    opts.onLog(`${slug}: created ${repoId} in ${result.createMs}ms — polling…`);
  } catch (e) {
    const ex = extractError(e);
    result.fatal = `create failed: ${ex.code ?? ex.name ?? 'error'}: ${ex.message}`;
    result.errorCode = ex.code;
    result.traceId = ex.traceId;
    opts.onLog(`${slug}: create FAILED — ${result.fatal}`);
    return result;
  }

  // 2. Poll branches.list() until populated or window elapses.
  const repo = freestyle.git.repos.ref({ repoId: result.repoId });
  const windowMs = opts.windowSecs * 1000;
  const intervalMs = opts.intervalSecs * 1000;
  const tPoll = Date.now();
  let lastErr: ExtractedError | null = null;

  while (Date.now() - tPoll < windowMs) {
    result.attempts++;
    try {
      await repo.branches.list();
      result.populated = true;
      result.populateMs = Date.now() - tPoll;
      opts.onLog(
        `${slug}: populated after ${result.populateMs}ms (${result.attempts} polls)`
      );
      break;
    } catch (e) {
      lastErr = extractError(e);
      // Early INTERNAL_ERROR is expected while import is still running; keep
      // polling. For the failing repos it simply never clears.
      await sleep(intervalMs);
    }
  }

  if (!result.populated && lastErr) {
    result.errorCode = lastErr.code;
    result.errorMessage = lastErr.message;
    result.errorCause = lastErr.cause;
    result.traceId = lastErr.traceId;
    opts.onLog(
      `${slug}: NEVER populated — ${lastErr.code ?? lastErr.name} after ` +
        `${result.attempts} polls / ${opts.windowSecs}s` +
        (lastErr.cause ? ` (cause ${lastErr.cause})` : '') +
        (lastErr.traceId ? ` (traceId ${lastErr.traceId})` : '')
    );
  }

  // 3. Teardown.
  if (!opts.noTeardown && result.repoId) {
    try {
      await freestyle.git.repos.delete({ repoId: result.repoId });
      result.tornDown = true;
    } catch {
      result.tornDown = false;
    }
  }

  return result;
}
