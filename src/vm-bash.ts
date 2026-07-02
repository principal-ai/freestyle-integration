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
 * the interactive VM console so they pull repos the same way.
 *
 * Shallow by default (`--depth 1` at the given rev) — enough to inspect what the
 * import resolved to, or to count lines at HEAD. Pass `{ fullHistory: true }`
 * for a complete clone: `git blame` needs the full commit history (and the
 * historical blobs), so the coverage sweep can't run against a shallow clone.
 */
export function cloneCommand(
  spec: RepoSpec,
  githubToken: string | undefined,
  opts: { fullHistory?: boolean } = {}
): string {
  const auth = githubToken ? `x-access-token:${githubToken}@` : '';
  const url = `https://${auth}github.com/${spec.owner}/${spec.repo}.git`;
  const branchArg = spec.rev ? `--branch ${spec.rev} ` : '';
  const depthArg = opts.fullHistory ? '' : '--depth 1 ';
  return `git clone ${depthArg}${branchArg}${url} /repo`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** The live VM handle returned by `freestyle.vms.create()`. */
export type VmHandle = Awaited<ReturnType<typeof freestyle.vms.create>>['vm'];

export interface ExecLongResult {
  statusCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a shell command that may take minutes, following Freestyle's documented
 * long-running-command pattern (docs: "Run Long Setup Steps Safely"): a single
 * long `vm.exec()` holds one HTTP request open and hits the client-side fetch
 * timeout (undici's defaults, which the SDK doesn't override) — the `fetch
 * failed` we saw cloning large repos. Instead, launch the command detached as a
 * transient systemd unit and make only SHORT polling calls against a marker
 * file, so no single request runs long enough to time out.
 *
 * stdout/stderr/exit are captured to files in the VM and read back once the unit
 * finishes. Returns the command's own exit code (the marker is always written,
 * even on non-zero exit, so a failed command surfaces as `statusCode`, not a
 * throw). Throws only if the unit dies without finishing or the budget elapses.
 */
export async function execLong(
  vm: VmHandle,
  name: string,
  command: string,
  opts: { windowSecs: number; pollIntervalMs?: number; onLog?: (msg: string) => void }
): Promise<ExecLongResult> {
  const unit = `job-${name}`;
  const base = `/tmp/${name}`;
  const done = `${base}.done`;
  const out = `${base}.out`;
  const err = `${base}.err`;
  const exit = `${base}.exit`;
  const scriptPath = `/root/${name}.sh`;

  // Wrapper: run the command, capture streams + exit, then drop the marker LAST
  // so its existence means "everything above is written".
  const script =
    `#!/bin/sh\n` +
    `{ ${command} ; } > ${out} 2> ${err}\n` +
    `echo $? > ${exit}\n` +
    `touch ${done}\n`;
  await vm.fs.writeTextFile(scriptPath, script);

  // Launch detached — this call returns immediately.
  await vm.exec(
    `chmod +x ${scriptPath} && rm -f ${done} ${exit} && ` +
      `systemd-run --unit=${unit} --collect /bin/sh ${scriptPath}`
  );

  const pollMs = opts.pollIntervalMs ?? 8000;
  const deadline = Date.now() + opts.windowSecs * 1000;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    polls++;
    const probe = await vm.exec(
      `if test -f ${done}; then echo __DONE__; else ` +
        `systemctl show ${unit} -p ActiveState -p Result --no-pager; fi`
    );
    const text = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
    if (text.includes('__DONE__')) {
      const code = (await vm.exec(`cat ${exit}`)).stdout ?? '1';
      const stdout = await vm.fs.readTextFile(out).catch(() => '');
      const stderr = await vm.fs.readTextFile(err).catch(() => '');
      opts.onLog?.(`${name}: finished (exit ${code.trim()}, ${polls} polls)`);
      return { statusCode: parseInt(code.trim(), 10) || 0, stdout, stderr };
    }
    // Unit vanished/failed without ever dropping the marker → it died mid-run.
    if (/Result=(oom-kill|exit-code|signal|core-dump)/.test(text)) {
      const stderr = await vm.fs.readTextFile(err).catch(() => '');
      throw new Error(`${unit} died: ${text.trim().slice(0, 160)} ${stderr.slice(0, 160)}`.trim());
    }
  }
  throw new Error(`${unit} did not finish within ${opts.windowSecs}s (${polls} polls)`);
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
