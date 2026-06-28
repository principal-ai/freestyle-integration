/**
 * Use-case registry — the pluggable surface the harness exercises.
 *
 * Every use case follows the same skeleton the original git-import probe
 * established: take a repo spec, create a Freestyle resource, drive it until it's
 * either ready or known-failed, record a structured result, and tear down. They
 * differ only in *which* Freestyle primitive they exercise:
 *
 *   - `git-import` — `git.repos.create({ source })` → poll `branches.list()`.
 *   - `vm-bash`    — `vms.create()` → clone + `vm.exec()` → read stdout.
 *
 * The CLI (`repro.ts`) and the server (`server.ts`) both pick a use case by id
 * and run the same repo list through it, so adding a use case here surfaces it
 * everywhere with no further wiring.
 */
import type { RepoSpec } from './repos.js';
import { probeRepo } from './probe.js';
import { execProbe } from './vm-bash.js';

/** Per-repo outcome, normalized across every use case so one table fits all. */
export interface RunResult {
  slug: string; // owner/repo
  rev: string | null;
  /** Was success expected for this repo (from the spec)? */
  expectOk: boolean;
  /** Did the use case actually succeed for this repo? */
  ok: boolean;
  /** Short status label, e.g. `populated`, `INTERNAL_ERROR`, `exec ok`. */
  status: string;
  /** One-line detail, e.g. `1830ms / 4 polls` or `exit 0, 142 files`. */
  detail: string;
  /** Total wall-clock for the repo, when measured. */
  durationMs: number | null;
  /** Freestyle trace id, when an error carried one. */
  traceId: string | null;
  /** Error message when the use case couldn't complete (vs. an expected fail). */
  error: string | null;
}

export interface RunOptions {
  /** Total seconds to wait for readiness before giving up. */
  windowSecs: number;
  /** Seconds between readiness polls. */
  intervalSecs: number;
  /** Skip teardown (leave Freestyle resources up for manual inspection). */
  noTeardown: boolean;
  githubToken: string | undefined;
  onLog: (msg: string) => void;
}

export interface UseCase {
  id: string;
  label: string;
  description: string;
  run(spec: RepoSpec, opts: RunOptions): Promise<RunResult>;
}

/** git-import: the original repro — exercise `git.repos.create({ source })`. */
const gitImport: UseCase = {
  id: 'git-import',
  label: 'Git source import',
  description:
    'Import a GitHub repo into Freestyle Git via git.repos.create({ source }) ' +
    'and poll branches.list() until it populates. Reproduces the hosted-authoring ' +
    'import path; some repos never populate (INTERNAL_ERROR).',
  async run(spec, opts) {
    const r = await probeRepo(spec, opts);
    let status: string;
    let detail: string;
    if (r.fatal) {
      status = 'CREATE FAILED';
      detail = r.traceId ? `trace ${r.traceId}` : r.errorCode ?? '';
    } else if (r.populated) {
      status = 'populated';
      detail = `${r.populateMs}ms / ${r.attempts} polls`;
    } else if (r.errorCode) {
      status = r.errorCode;
      detail = r.traceId ? `trace ${r.traceId}` : `${r.attempts} polls`;
    } else {
      status = 'client error';
      detail = `${r.errorMessage ?? 'unknown'}${r.errorCause ? ` (${r.errorCause})` : ''}`;
    }
    return {
      slug: r.slug,
      rev: r.rev,
      expectOk: r.expectOk,
      ok: r.populated,
      status,
      detail,
      durationMs: r.populateMs ?? r.createMs,
      traceId: r.traceId,
      error: r.fatal,
    };
  },
};

/** vm-bash: create a VM, clone the repo, run a bash command, read stdout. */
const vmBash: UseCase = {
  id: 'vm-bash',
  label: 'VM bash exec',
  description:
    'Boot a Freestyle VM, clone the repo into it, and run a bash command via ' +
    'vm.exec(). Verifies the curl-able-bash building block: a VM can shell out ' +
    'against a cloned repo and return stdout. Pass = clone + command exit 0 with output.',
  run: execProbe,
};

export const USE_CASES: UseCase[] = [gitImport, vmBash];

export function getUseCase(id: string): UseCase {
  const uc = USE_CASES.find((u) => u.id === id);
  if (!uc) {
    throw new Error(
      `unknown use case "${id}" — known: ${USE_CASES.map((u) => u.id).join(', ')}`
    );
  }
  return uc;
}
