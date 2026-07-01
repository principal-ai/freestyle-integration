/**
 * The git-linecount probe — produce the **per-file line counts** for a repo on
 * a Freestyle VM: the metric the web-ade File City map turns into 3D building
 * heights. This is a different, cheaper number than the blame ownership map
 * (`git-coverage`): a raw newline count, not a blame total.
 *
 * It mirrors the electron-app's `GitRepositoryService.countLinesInRepository`
 * exactly — same `git ls-files` enumeration, same binary-extension skip, same
 * 1 MB cap, same `countLinesInContent` rule (newlines, +1 when the file doesn't
 * end in one) — so the output matches web-ade's line-counts cache byte-for-byte.
 * The emitted `{ lineCounts, fileCount }` is the exact body the app already PUTs
 * to `https://app.principal-ade.com/api/line-counts/{owner}/{repo}`.
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
import { cloneCommand, describeError } from './vm-bash.js';

/** The shape the sweep emits — the exact body the electron-app PUTs to the
 *  web-ade line-counts cache. */
export interface LineCountMap {
  /** repo-relative path → line count (newlines, +1 when no trailing newline). */
  lineCounts: Record<string, number>;
  /** Number of files counted — `Object.keys(lineCounts).length`. */
  fileCount: number;
}

/**
 * The in-VM sweep. Pure stdlib Python (git + python3 are on the VM). Mirrors
 * `countLinesInRepository` + `countLinesInContent`: the binary-extension set,
 * the 1 MB cap, and the newline rule are copied from the app so the counts are
 * identical to what the desktop app caches.
 */
const SWEEP_PY = String.raw`
import json, os, subprocess, sys

repo = sys.argv[1] if len(sys.argv) > 1 else "/repo"

# Copied verbatim from GitRepositoryService.BINARY_EXTENSIONS.
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
    # Mirrors filePath.split('.').pop()?.toLowerCase(): the last dot-segment
    # (the whole name when there's no dot).
    return p.split(".")[-1].lower() in BINARY

def count_lines(content):
    # Mirrors countLinesInContent: newline total, +1 when no trailing newline.
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
        # Deleted or unreadable — skip, matching the app's try/catch.
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

/** Where the full line-count map lands for inspection / hand-off to web-ade. */
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
  const timeoutMs = opts.windowSecs * 1000;

  const tStart = Date.now();
  let vmId: string | null = null;
  let vm: Awaited<ReturnType<typeof freestyle.vms.create>>['vm'] | null = null;

  try {
    // 1. Create a throwaway VM.
    const created = await freestyle.vms.create({
      name: `gitlc-${spec.owner}-${spec.repo}-${tStart}`,
      persistence: { type: 'ephemeral' },
      idleTimeoutSeconds: 120,
    });
    vm = created.vm;
    vmId = created.vmId;
    opts.onLog(`${slug}: VM ${vmId} created — cloning…`);

    // 2. Clone the repo onto the VM (shallow).
    const clone = await vm.exec({ command: cloneCmd, timeoutMs });
    if ((clone.statusCode ?? 1) !== 0) {
      result.status = 'clone failed';
      result.detail = `exit ${clone.statusCode} — ${(clone.stderr ?? '').trim().slice(0, 120)}`;
      opts.onLog(`${slug}: clone FAILED (exit ${clone.statusCode})`);
      return result;
    }
    opts.onLog(`${slug}: cloned — counting lines…`);

    // 3. Count every tracked text file in one exec, read JSON back.
    const sweep = await vm.exec({ command: sweepCommand(), timeoutMs });
    if ((sweep.statusCode ?? 1) !== 0) {
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
