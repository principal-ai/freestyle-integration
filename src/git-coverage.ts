/**
 * The git-coverage probe — produce the **ownership map** for a repo on a
 * Freestyle VM: which contributor owns how many lines of which file, by
 * `git blame` at HEAD. This is the data the web-ade File City map consumes to
 * highlight a contributor's coverage.
 *
 * The sweep aggregates blame by author email into a `byEmail` map (email → file
 * → lines) plus a `totalLines` per file. The VM produces this source map; the
 * consumer owns the rendering.
 *
 *   1. `vms.create()` — a throwaway VM.
 *   2. `vm.exec(git clone …)` — FULL history (blame needs it; not `--depth 1`).
 *   3. `vm.exec(python3 sweep.py /repo)` — ONE call runs the whole blame sweep
 *      inside the VM and prints aggregated JSON. Doing the sweep in-VM (not one
 *      `vm.exec` per file) is the whole point: blame stays local to disk and
 *      only a few KB–MB of JSON crosses the wire, instead of thousands of
 *      round-trips and gigabytes of raw porcelain.
 *   4. `vm.delete()` — tear the VM down regardless of outcome.
 *
 * The full ownership map is written to `results/coverage-<owner>-<repo>.json`;
 * the run table shows a one-line summary (files / authors / lines).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { freestyle } from 'freestyle';
import type { RepoSpec } from './repos.js';
import type { RunOptions, RunResult } from './use-cases.js';
import { cloneCommand, describeError, execLong } from './vm-bash.js';

/** The shape the sweep emits — the ownership map plus a contributor list (from
 *  `git shortlog`) so a consumer can label authors. */
export interface OwnershipMap {
  /** email → { repo-relative path → lines that email owns at HEAD }. */
  byEmail: Record<string, Record<string, number>>;
  /** repo-relative path → total blamed (non-binary) lines in that file. */
  totalLines: Record<string, number>;
  /** Sum of every `totalLines` value. */
  totalLinesGlobal: number;
  /** `git shortlog -s -n -e --all` rows: who committed, how often. */
  contributors: Array<{ name: string; commits: number; email: string }>;
}

/**
 * The in-VM sweep. Pure stdlib Python (git + python3 are on the VM) so it ships
 * as one file and needs no deps. Reads a repo path, prints an `OwnershipMap` as
 * JSON to stdout via `git blame --line-porcelain`, an empty-tree numstat to skip
 * binaries, and `author-mail` aggregation by email.
 */
const SWEEP_PY = String.raw`
import json, subprocess, sys, re
from concurrent.futures import ThreadPoolExecutor

repo = sys.argv[1] if len(sys.argv) > 1 else "/repo"

def git(args):
    return subprocess.run(["git", "-C", repo] + args,
                          capture_output=True, text=True, errors="replace")

# 1. Tracked files at HEAD.
files = [f for f in git(["ls-files"]).stdout.split("\n") if f]

# 2. Drop binaries — blaming a binary emits megabytes of porcelain and its
#    "lines" don't belong in an ownership count. The empty-tree numstat marks
#    binary paths with "-\t-". Best-effort: on failure, blame everything.
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
binary = set()
for line in git(["diff", "--numstat", EMPTY_TREE, "HEAD"]).stdout.split("\n"):
    parts = line.split("\t")
    if len(parts) == 3 and parts[0] == "-" and parts[1] == "-":
        binary.add(parts[2])
files = [f for f in files if f not in binary]

# 3. Blame each file, count each line's author-mail, aggregate by email.
def blame(f):
    r = git(["blame", "--line-porcelain", "-w", "HEAD", "--", f])
    if r.returncode != 0:
        return f, None, 0
    counts = {}
    n = 0
    for line in r.stdout.split("\n"):
        if line.startswith("author-mail "):
            a = line.find("<")
            b = line.find(">", a)
            if a != -1 and b != -1:
                email = line[a + 1:b].lower()
                counts[email] = counts.get(email, 0) + 1
                n += 1
    return f, counts, n

by_email = {}
total_lines = {}
total_global = 0

# Concurrency is in-VM against local disk (the GIL is released across the
# subprocess wait), so blame runs 8-way in parallel.
with ThreadPoolExecutor(max_workers=8) as ex:
    for f, counts, n in ex.map(blame, files):
        if not counts or n <= 0:
            continue
        total_lines[f] = n
        total_global += n
        for email, lines in counts.items():
            d = by_email.setdefault(email, {})
            d[f] = d.get(f, 0) + lines

# 4. Contributor list — "  <count>\t<name> <email>".
contributors = []
for line in git(["shortlog", "-s", "-n", "-e", "--all"]).stdout.split("\n"):
    m = re.match(r"^\s*(\d+)\s+(.+?)\s+<([^>]*)>$", line)
    if m:
        contributors.append({
            "name": m.group(2),
            "commits": int(m.group(1)),
            "email": m.group(3).lower(),
        })

json.dump({
    "byEmail": by_email,
    "totalLines": total_lines,
    "totalLinesGlobal": total_global,
    "contributors": contributors,
}, sys.stdout)
`;

/** Write the sweep into the VM (base64 to dodge all quoting) and run it.
 *  Exported so the Freestyle-Git variant (`git-freestyle.ts`) runs the identical
 *  blame sweep against a repo cloned from `git.freestyle.sh` instead of GitHub. */
export function coverageSweepCommand(): string {
  const b64 = Buffer.from(SWEEP_PY, 'utf8').toString('base64');
  return (
    `printf %s '${b64}' | base64 -d > /tmp/sweep.py && ` +
    `python3 /tmp/sweep.py /repo`
  );
}

/** Where the full ownership map lands for inspection / hand-off. */
function outputPath(spec: RepoSpec): string {
  return path.resolve('results', `coverage-${spec.owner}-${spec.repo}.json`);
}

export async function coverageProbe(
  spec: RepoSpec,
  opts: RunOptions
): Promise<RunResult> {
  const slug = `${spec.owner}/${spec.repo}`;
  const result: RunResult = {
    slug,
    rev: spec.rev,
    expectOk: spec.expectOk,
    ok: false,
    status: 'unknown',
    detail: '',
    durationMs: null,
    traceId: null,
    error: null,
  };

  // Full history — blame can't run against a shallow clone.
  const cloneCmd = cloneCommand(spec, opts.githubToken, { fullHistory: true });

  const tStart = Date.now();
  let vmId: string | null = null;
  let vm: Awaited<ReturnType<typeof freestyle.vms.create>>['vm'] | null = null;

  try {
    // 1. Create a throwaway VM.
    const created = await freestyle.vms.create({
      name: `gitcov-${spec.owner}-${spec.repo}-${tStart}`,
      // Persistent (NOT ephemeral): the clone/sweep run as detached units, and if
      // the VM suspends mid-run an ephemeral VM loses its disk ("VM files have
      // been deleted") — the /repo we just cloned vanishes before the sweep can
      // read it. Persistent files survive a suspend/resume. idleTimeoutSeconds:
      // null avoids idle-suspend churn; we always tear down in `finally`.
      persistence: { type: 'persistent' },
      idleTimeoutSeconds: null,
    });
    vm = created.vm;
    vmId = created.vmId;
    opts.onLog(`${slug}: VM ${vmId} created — cloning (full history)…`);

    // 2. Clone the repo onto the VM. A full-history clone of a large repo can
    //    run for minutes, so use the long-running pattern (detached unit + short
    //    marker polls) instead of one long vm.exec that hits the fetch timeout.
    const clone = await execLong(vm, 'clone', cloneCmd, {
      windowSecs: opts.windowSecs,
      onLog: (m) => opts.onLog(`${slug}: ${m}`),
    });
    if (clone.statusCode !== 0) {
      result.status = 'clone failed';
      result.detail = `exit ${clone.statusCode} — ${clone.stderr.trim().slice(0, 120)}`;
      opts.onLog(`${slug}: clone FAILED (exit ${clone.statusCode})`);
      return result;
    }
    opts.onLog(`${slug}: cloned — running blame sweep…`);

    // 3. Run the whole ownership sweep (also long on big repos), read JSON back.
    const sweep = await execLong(vm, 'coverage-sweep', coverageSweepCommand(), {
      windowSecs: opts.windowSecs,
      onLog: (m) => opts.onLog(`${slug}: ${m}`),
    });
    if (sweep.statusCode !== 0) {
      result.status = 'sweep failed';
      result.detail = `exit ${sweep.statusCode} — ${(sweep.stderr ?? '').trim().slice(0, 120)}`;
      opts.onLog(`${slug}: sweep FAILED (exit ${sweep.statusCode})`);
      return result;
    }

    let map: OwnershipMap;
    try {
      map = JSON.parse(sweep.stdout ?? '');
    } catch {
      result.status = 'bad output';
      result.detail = `unparseable JSON — ${(sweep.stdout ?? '').trim().slice(0, 80)}`;
      opts.onLog(`${slug}: sweep returned unparseable output`);
      return result;
    }

    const nFiles = Object.keys(map.totalLines).length;
    const nAuthors = Object.keys(map.byEmail).length;
    result.ok = nFiles > 0;
    result.status = result.ok ? 'coverage ok' : 'coverage empty';

    // Persist the full map; the table only carries a summary.
    const out = outputPath(spec);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(map, null, 2));

    result.detail = `${nFiles} files, ${nAuthors} authors, ${map.totalLinesGlobal} lines → ${path.relative(process.cwd(), out)}`;
    opts.onLog(
      `${slug}: ${result.status} (${nFiles} files, ${nAuthors} authors, ${map.totalLinesGlobal} lines)`
    );
  } catch (e) {
    const { message, traceId } = describeError(e);
    result.status = vmId ? 'sweep error' : 'CREATE FAILED';
    result.error = message;
    result.traceId = traceId;
    result.detail = traceId ? `trace ${traceId}` : message.slice(0, 120);
    opts.onLog(`${slug}: ${result.status} — ${message}`);
  } finally {
    result.durationMs = Date.now() - tStart;
    // 4. Teardown.
    if (!opts.noTeardown && vmId && vm) {
      try {
        await vm.delete();
      } catch {
        opts.onLog(`${slug}: WARNING — VM ${vmId} teardown failed (leaked)`);
      }
    }
  }

  return result;
}
