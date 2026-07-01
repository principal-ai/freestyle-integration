/**
 * Use-case registry — the pluggable surface the harness exercises.
 *
 * Every use case follows the same skeleton the original git-import probe
 * established: take a repo spec, create a Freestyle resource, drive it until it's
 * either ready or known-failed, record a structured result, and tear down. They
 * differ only in *which* Freestyle primitive they exercise:
 *
 *   - `git-import`   — `git.repos.create({ source })` → poll `branches.list()`.
 *   - `vm-bash`      — `vms.create()` → clone + `vm.exec()` → read stdout.
 *   - `git-coverage` — `vms.create()` → full clone → in-VM blame sweep →
 *                      ownership map (email → file → lines) for the web-ade map.
 *   - `git-linecount`— `vms.create()` → shallow clone → in-VM line-count sweep →
 *                      per-file line counts that drive the web-ade 3D heights.
 *   - `git-coverage-fs` — import into Freestyle Git → identity/token → VM clone
 *                      from `git.freestyle.sh` → the same blame sweep as
 *                      `git-coverage`, over the production import path.
 *
 * The CLI (`repro.ts`) and the server (`server.ts`) both pick a use case by id
 * and run the same repo list through it, so adding a use case here surfaces it
 * everywhere with no further wiring.
 */
import type { RepoSpec } from './repos.js';
import { probeRepo } from './probe.js';
import { execProbe } from './vm-bash.js';
import { coverageProbe } from './git-coverage.js';
import { lineCountProbe } from './git-linecount.js';
import { coverageFreestyleProbe } from './git-freestyle.js';

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

/** git-coverage: full clone + in-VM blame sweep → contributor ownership map. */
const gitCoverage: UseCase = {
  id: 'git-coverage',
  label: 'Git ownership map',
  description:
    'Boot a Freestyle VM, full-clone the repo, and run a single in-VM git blame ' +
    'sweep that emits the ownership map (email → file → lines) — the data the ' +
    'web-ade File City map consumes to highlight a contributor. Mirrors the ' +
    "electron-app's getOwnershipMap; the full map is written to results/.",
  run: coverageProbe,
};

/** git-linecount: shallow clone + in-VM line-count sweep → per-file line counts. */
const gitLineCount: UseCase = {
  id: 'git-linecount',
  label: 'Git line counts',
  description:
    'Boot a Freestyle VM, shallow-clone the repo, and count lines in every ' +
    'tracked text file in one in-VM sweep — the metric the web-ade File City ' +
    'map turns into 3D building heights. Mirrors the electron-app\'s ' +
    'countLinesInRepository; emits the { lineCounts, fileCount } shape the app ' +
    'PUTs to the web-ade line-counts cache. Full map written to results/.',
  run: lineCountProbe,
};

/** git-coverage-fs: import into Freestyle Git → VM clone from git.freestyle.sh →
 *  the same blame sweep. Tests the ownership map over the production import path. */
const gitCoverageFreestyle: UseCase = {
  id: 'git-coverage-fs',
  label: 'Git ownership map (Freestyle Git)',
  description:
    'Import the repo into Freestyle Git (git.repos.create({ source })), mint a ' +
    'scoped read token, then have a VM clone from git.freestyle.sh and run the ' +
    'identical blame sweep as git-coverage. Tests whether the ownership map can ' +
    'be built over the production Freestyle Git import path (and whether the ' +
    'import preserves full history). Full map written to results/coverage-fs-*.',
  run: coverageFreestyleProbe,
};

export const USE_CASES: UseCase[] = [
  gitImport,
  vmBash,
  gitCoverage,
  gitLineCount,
  gitCoverageFreestyle,
];

export function getUseCase(id: string): UseCase {
  const uc = USE_CASES.find((u) => u.id === id);
  if (!uc) {
    throw new Error(
      `unknown use case "${id}" — known: ${USE_CASES.map((u) => u.id).join(', ')}`
    );
  }
  return uc;
}
