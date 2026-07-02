/**
 * The git-linecount probe — produce the **per-file line counts** for a repo on
 * a Freestyle VM: the metric the web-ade File City map turns into 3D building
 * heights. This is a different, cheaper number than the blame ownership map
 * (`git-coverage`): a raw newline count, not a blame total.
 *
 * The rules: `git ls-files` enumeration, skip binary extensions, skip files over
 * 1 MB, and count newlines (+1 when the file doesn't end in one). The emitted
 * `{ lineCounts, fileCount }` is a plain per-file line-count map.
 *
 *   1. `vms.create()` — a throwaway VM.
 *   2. `vm.exec(git clone --depth 1 …)` — SHALLOW; line counts read the working
 *      tree at HEAD and need no history (unlike the blame sweep).
 *   3. `vm.exec(python3 sweep.py /repo)` — ONE call counts every tracked text
 *      file inside the VM and prints `{ lineCounts, fileCount }` as JSON.
 *   4. `vm.delete()` — tear the VM down regardless of outcome.
 *
 * The full map is written to `results/linecount-<owner>-<repo>.json`; the run
 * table shows a one-line summary (files / total lines).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { freestyle } from 'freestyle';
import type { RepoSpec } from './repos.js';
import type { RunOptions, RunResult } from './use-cases.js';
import { cloneCommand, describeError, execLong } from './vm-bash.js';

/** The shape the sweep emits — a per-file line-count map. */
export interface LineCountMap {
  /** repo-relative path → line count (newlines, +1 when no trailing newline). */
  lineCounts: Record<string, number>;
  /** Number of files counted — `Object.keys(lineCounts).length`. */
  fileCount: number;
}

/**
 * The in-VM sweep. Pure stdlib Python (git + python3 are on the VM). Enumerates
 * tracked files, skips the binary-extension set and files over 1 MB, and counts
 * newlines (+1 when there's no trailing newline).
 */
const SWEEP_PY = String.raw`
import json, os, subprocess, sys

repo = sys.argv[1] if len(sys.argv) > 1 else "/repo"

# Binary extensions to skip — a byte count isn't a meaningful line count.
BINARY = {
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg",
    "mp3", "mp4", "wav", "avi", "mov", "webm", "ogg",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "zip", "tar", "gz", "rar", "7z", "bz2",
    "exe", "dll", "so", "dylib", "bin",
    "ttf", "otf", "woff", "woff2", "eot",
    "db", "sqlite", "sqlite3",
    "lock", "lockb",
}

def git(args):
    return subprocess.run(["git", "-C", repo] + args,
                          capture_output=True, text=True, errors="replace")

# Tracked files only — gitignored/untracked files never enter the map.
files = [f for f in git(["ls-files"]).stdout.split("\n") if f]

def is_binary(p):
    # The last dot-segment, lowercased (the whole name when there's no dot).
    return p.split(".")[-1].lower() in BINARY

def count_lines(content):
    # Newline total, +1 when there's no trailing newline.
    if not content:
        return 0
    newlines = content.count("\n")
    return newlines if content.endswith("\n") else newlines + 1

line_counts = {}
for f in files:
    if is_binary(f):
        continue
    full = os.path.join(repo, f)
    try:
        # Skip files over 1 MB (likely minified/generated).
        if os.path.getsize(full) > 1024 * 1024:
            continue
        with open(full, "r", encoding="utf-8", errors="replace") as fh:
            content = fh.read()
    except OSError:
        # Deleted or unreadable — skip.
        continue
    line_counts[f] = count_lines(content)

json.dump({"lineCounts": line_counts, "fileCount": len(line_counts)}, sys.stdout)
`;

/** Write the sweep into the VM (base64 to dodge all quoting) and run it. */
function sweepCommand(): string {
  const b64 = Buffer.from(SWEEP_PY, 'utf8').toString('base64');
  return (
    `printf %s '${b64}' | base64 -d > /tmp/linecount.py && ` +
    `python3 /tmp/linecount.py /repo`
  );
}

/** Where the full line-count map lands for inspection / hand-off. */
function outputPath(spec: RepoSpec): string {
  return path.resolve('results', `linecount-${spec.owner}-${spec.repo}.json`);
}

export async function lineCountProbe(
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

  // Shallow is enough — line counts read the working tree at HEAD.
  const cloneCmd = cloneCommand(spec, opts.githubToken);

  const tStart = Date.now();
  let vmId: string | null = null;
  let vm: Awaited<ReturnType<typeof freestyle.vms.create>>['vm'] | null = null;

  try {
    // 1. Create a throwaway VM.
    const created = await freestyle.vms.create({
      name: `gitlc-${spec.owner}-${spec.repo}-${tStart}`,
      // Persistent (NOT ephemeral): a long detached clone/sweep can suspend
      // mid-run, and an ephemeral VM loses its disk on suspend ("VM files have
      // been deleted"). Persistent files survive; we tear down in `finally`.
      persistence: { type: 'persistent' },
      idleTimeoutSeconds: null,
    });
    vm = created.vm;
    vmId = created.vmId;
    opts.onLog(`${slug}: VM ${vmId} created — cloning…`);

    // 2. Clone the repo onto the VM (shallow). Long-running pattern (detached
    //    unit + short marker polls) keeps a big shallow tree from timing out.
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
    opts.onLog(`${slug}: cloned — counting lines…`);

    // 3. Count every tracked text file, read JSON back.
    const sweep = await execLong(vm, 'linecount-sweep', sweepCommand(), {
      windowSecs: opts.windowSecs,
      onLog: (m) => opts.onLog(`${slug}: ${m}`),
    });
    if (sweep.statusCode !== 0) {
      result.status = 'count failed';
      result.detail = `exit ${sweep.statusCode} — ${(sweep.stderr ?? '').trim().slice(0, 120)}`;
      opts.onLog(`${slug}: count FAILED (exit ${sweep.statusCode})`);
      return result;
    }

    let map: LineCountMap;
    try {
      map = JSON.parse(sweep.stdout ?? '');
    } catch {
      result.status = 'bad output';
      result.detail = `unparseable JSON — ${(sweep.stdout ?? '').trim().slice(0, 80)}`;
      opts.onLog(`${slug}: count returned unparseable output`);
      return result;
    }

    const totalLines = Object.values(map.lineCounts).reduce((a, b) => a + b, 0);
    result.ok = map.fileCount > 0;
    result.status = result.ok ? 'count ok' : 'count empty';

    // Persist the full map; the table only carries a summary.
    const out = outputPath(spec);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(map, null, 2));

    result.detail = `${map.fileCount} files, ${totalLines} lines → ${path.relative(process.cwd(), out)}`;
    opts.onLog(`${slug}: ${result.status} (${map.fileCount} files, ${totalLines} lines)`);
  } catch (e) {
    const { message, traceId } = describeError(e);
    result.status = vmId ? 'count error' : 'CREATE FAILED';
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
