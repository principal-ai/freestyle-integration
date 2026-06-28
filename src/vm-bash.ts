/**
 * The vm-bash probe — exercise the building block behind a curl-able bash
 * endpoint: boot a Freestyle VM, clone a repo into it, and run a bash command
 * with `vm.exec()`, reading stdout back.
 *
 * This is the verification cousin of the "curl <site>/<owner>/<repo>/bash"
 * feature idea — it doesn't stand up an HTTP endpoint, it just proves the
 * primitive works against a given repo:
 *
 *   1. `vms.create({ persistence: 'ephemeral' })` — a throwaway VM.
 *   2. `vm.exec('git clone --depth 1 …')` — pull the repo onto the VM.
 *   3. `vm.exec('cd /repo && …')` — run the actual command, capture stdout.
 *   4. `vm.delete()` — tear the VM down regardless of outcome.
 *
 * Pass = both the clone and the command exit 0 and the command returns output.
 * A per-repo VM keeps each run isolated and mirrors git-import's create→use→
 * teardown shape (the warm-pool optimization belongs to the real feature, not
 * this probe).
 */
import { freestyle } from 'freestyle';
import type { RepoSpec } from './repos.js';
import type { RunOptions, RunResult } from './use-cases.js';

/** The command run against the cloned repo. Counts tracked files as a cheap, */
/** deterministic "the VM can shell out and see the repo" signal.            */
const CHECK_COMMAND =
  "cd /repo && find . -type f -not -path './.git/*' | wc -l";

/**
 * The `git clone` command for a repo. Token is embedded host-side so private
 * repos clone (and public repos dodge the rate limit); shared by the probe and
 * the interactive VM console so they pull repos the same way. Shallow (depth 1
 * at the given rev) — enough to inspect what the import resolved to.
 */
export function cloneCommand(spec: RepoSpec, githubToken: string | undefined): string {
  const auth = githubToken ? `x-access-token:${githubToken}@` : '';
  const url = `https://${auth}github.com/${spec.owner}/${spec.repo}.git`;
  const branchArg = spec.rev ? `--branch ${spec.rev} ` : '';
  return `git clone --depth 1 ${branchArg}${url} /repo`;
}

/** Pull a trace id / message off a thrown Freestyle SDK error. */
export function describeError(e: unknown): { message: string; traceId: string | null } {
  const err = e as {
    body?: { message?: string };
    traceId?: string;
    message?: string;
  };
  return {
    message: err?.body?.message ?? (e instanceof Error ? e.message : String(e)),
    traceId: err?.traceId ?? null,
  };
}

export async function execProbe(
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

  // Clone command (token embedded host-side, never logged).
  const cloneCmd = cloneCommand(spec, opts.githubToken);
  const timeoutMs = opts.windowSecs * 1000;

  const tStart = Date.now();
  let vmId: string | null = null;
  let vm: Awaited<ReturnType<typeof freestyle.vms.create>>['vm'] | null = null;

  try {
    // 1. Create a throwaway VM.
    const created = await freestyle.vms.create({
      name: `vmbash-${spec.owner}-${spec.repo}-${tStart}`,
      persistence: { type: 'ephemeral' },
      idleTimeoutSeconds: 120,
    });
    vm = created.vm;
    vmId = created.vmId;
    opts.onLog(`${slug}: VM ${vmId} created — cloning…`);

    // 2. Clone the repo onto the VM.
    const clone = await vm.exec({ command: cloneCmd, timeoutMs });
    if ((clone.statusCode ?? 1) !== 0) {
      result.status = 'clone failed';
      result.detail = `exit ${clone.statusCode} — ${(clone.stderr ?? '').trim().slice(0, 120)}`;
      opts.onLog(`${slug}: clone FAILED (exit ${clone.statusCode})`);
      return result;
    }
    opts.onLog(`${slug}: cloned — running check command…`);

    // 3. Run the actual bash command and read stdout back.
    const check = await vm.exec({ command: CHECK_COMMAND, timeoutMs });
    const stdout = (check.stdout ?? '').trim();
    const exit = check.statusCode ?? 1;
    result.ok = exit === 0 && stdout.length > 0;
    result.status = result.ok ? 'exec ok' : 'exec failed';
    result.detail = `exit ${exit}, ${stdout ? `${stdout} files` : 'no output'}`;
    opts.onLog(
      `${slug}: ${result.status} (exit ${exit}${stdout ? `, ${stdout} files` : ''})`
    );
  } catch (e) {
    const { message, traceId } = describeError(e);
    result.status = vmId ? 'exec error' : 'CREATE FAILED';
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
