/**
 * The git-coverage-fs probe — the same ownership sweep as `git-coverage`, but the
 * repo reaches the VM through **Freestyle Git** instead of a direct GitHub clone.
 *
 * This tests the production hosted-authoring shape end to end: import the GitHub
 * repo into a hosted Freestyle Git repo, then have the VM clone from
 * `git.freestyle.sh/{repoId}` (authenticated with a scoped identity token) and
 * run the identical in-VM `git blame` sweep. The open question it answers: does a
 * Freestyle Git import preserve **full commit history**? Blame needs it — if the
 * import only carries the tip, coverage comes back empty even when the import
 * "populates".
 *
 *   1. `git.repos.create({ source: { url, rev } })` — server-side import; poll
 *      `branches.list()` until it populates (or the window elapses).
 *   2. `identities.create()` → `permissions.git.grant({ repoId, 'read' })` →
 *      `tokens.create()` — a scoped read token for the VM to clone with.
 *   3. `vms.create()` → clone `git.freestyle.sh/{repoId}` (FULL history) →
 *      run the shared coverage sweep → read the ownership map back.
 *   4. Tear down all THREE resources (VM, identity, Freestyle Git repo).
 *
 * The full map is written to `results/coverage-fs-<owner>-<repo>.json`.
 *
 * Contrast with `git-coverage` (direct GitHub clone): identical sweep and output
 * shape, so any difference in the result is attributable to the Freestyle Git
 * import path — which is the whole point of running both.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { freestyle } from 'freestyle';
import type { RepoSpec } from './repos.js';
import type { RunOptions, RunResult } from './use-cases.js';
import { describeError, execLong } from './vm-bash.js';
import { coverageSweepCommand, type OwnershipMap } from './git-coverage.js';

/** Where the full ownership map lands — `-fs-` marks the Freestyle-Git variant
 *  so it never collides with the direct-clone `git-coverage` output. */
function outputPath(spec: RepoSpec): string {
  return path.resolve('results', `coverage-fs-${spec.owner}-${spec.repo}.json`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Import the GitHub repo into Freestyle Git and mint a scoped read token, then
 * return the authenticated `git.freestyle.sh` clone URL plus the resource ids to
 * tear down. Polls `branches.list()` as the readiness signal (same one a VM
 * clone depends on: while it errors, the clone returns HTTP 500). Throws if the
 * import never populates within the window.
 */
async function provisionFreestyleGitClone(
  spec: RepoSpec,
  opts: RunOptions,
  ids: { repoId: string | null; identityId: string | null }
): Promise<string> {
  const slug = `${spec.owner}/${spec.repo}`;

  // 1. Import the GitHub repo into Freestyle Git (documented source shape).
  const auth = opts.githubToken ? `x-access-token:${opts.githubToken}@` : '';
  const url = `https://${auth}github.com/${spec.owner}/${spec.repo}.git`;
  const { repoId } = await freestyle.git.repos.create({
    name: `covfs-${spec.owner}-${spec.repo}-${Date.now()}`,
    source: { url, rev: spec.rev },
  });
  ids.repoId = repoId;
  opts.onLog(`${slug}: Freestyle Git repo ${repoId} created — polling import…`);

  // Poll branches.list() until the import populates or the window elapses.
  const repo = freestyle.git.repos.ref({ repoId });
  const windowMs = opts.windowSecs * 1000;
  const intervalMs = opts.intervalSecs * 1000;
  const tPoll = Date.now();
  let populated = false;
  let lastErr: string | null = null;
  let attempts = 0;
  while (Date.now() - tPoll < windowMs) {
    attempts++;
    try {
      await repo.branches.list();
      populated = true;
      opts.onLog(`${slug}: import populated after ${attempts} polls`);
      break;
    } catch (e) {
      lastErr = describeError(e).message;
      await sleep(intervalMs);
    }
  }
  if (!populated) {
    throw new Error(
      `Freestyle Git import never populated (${attempts} polls / ${opts.windowSecs}s)` +
        (lastErr ? ` — ${lastErr}` : '')
    );
  }

  // 2. Scoped identity + read grant + token for the VM to clone with.
  const { identityId } = await freestyle.identities.create();
  ids.identityId = identityId;
  const ident = freestyle.identities.ref({ identityId });
  await ident.permissions.git.grant({ repoId, permission: 'read' });
  const { token } = await ident.tokens.create();
  opts.onLog(`${slug}: identity ${identityId} granted read — clone token minted`);

  // Authenticated clone URL against the hosted Freestyle Git server.
  return `https://x-access-token:${token}@git.freestyle.sh/${repoId}`;
}

export async function coverageFreestyleProbe(
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

  const tStart = Date.now();
  const ids: { repoId: string | null; identityId: string | null } = {
    repoId: null,
    identityId: null,
  };
  let vmId: string | null = null;
  let vm: Awaited<ReturnType<typeof freestyle.vms.create>>['vm'] | null = null;

  try {
    // 1+2. Import into Freestyle Git and get an authenticated clone URL.
    const cloneUrl = await provisionFreestyleGitClone(spec, opts, ids);
    // Full history — blame can't run against a shallow clone.
    const cloneCmd = `git clone ${cloneUrl} /repo`;

    // 3. Create a throwaway VM and clone from Freestyle Git.
    const created = await freestyle.vms.create({
      name: `covfs-${spec.owner}-${spec.repo}-${tStart}`,
      // Persistent (NOT ephemeral): a long detached clone/sweep can suspend
      // mid-run, and an ephemeral VM loses its disk on suspend ("VM files have
      // been deleted"). Persistent files survive; we tear down in `finally`.
      persistence: { type: 'persistent' },
      idleTimeoutSeconds: null,
    });
    vm = created.vm;
    vmId = created.vmId;
    opts.onLog(`${slug}: VM ${vmId} created — cloning from Freestyle Git (full history)…`);

    // Long-running clone/sweep: detached unit + short marker polls, so a large
    // full-history clone doesn't hold one vm.exec open past the fetch timeout.
    const clone = await execLong(vm, 'clone', cloneCmd, {
      windowSecs: opts.windowSecs,
      onLog: (m) => opts.onLog(`${slug}: ${m}`),
    });
    if (clone.statusCode !== 0) {
      result.status = 'clone failed';
      result.detail = `exit ${clone.statusCode} — ${clone.stderr.trim().slice(0, 120)}`;
      opts.onLog(`${slug}: Freestyle-Git clone FAILED (exit ${clone.statusCode})`);
      return result;
    }
    opts.onLog(`${slug}: cloned — running blame sweep…`);

    // Run the shared ownership sweep, read JSON back.
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

    const out = outputPath(spec);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(map, null, 2));

    result.detail = `${nFiles} files, ${nAuthors} authors, ${map.totalLinesGlobal} lines → ${path.relative(process.cwd(), out)}`;
    opts.onLog(
      `${slug}: ${result.status} (${nFiles} files, ${nAuthors} authors, ${map.totalLinesGlobal} lines)`
    );
  } catch (e) {
    const { message, traceId } = describeError(e);
    result.status = vmId ? 'sweep error' : ids.repoId ? 'import error' : 'CREATE FAILED';
    result.error = message;
    result.traceId = traceId;
    result.detail = traceId ? `trace ${traceId}` : message.slice(0, 120);
    opts.onLog(`${slug}: ${result.status} — ${message}`);
  } finally {
    result.durationMs = Date.now() - tStart;
    // 4. Teardown — all three resources, each independently, best-effort.
    if (!opts.noTeardown) {
      if (vmId && vm) {
        try {
          await vm.delete();
        } catch {
          opts.onLog(`${slug}: WARNING — VM ${vmId} teardown failed (leaked)`);
        }
      }
      if (ids.identityId) {
        try {
          await freestyle.identities.delete({ identityId: ids.identityId });
        } catch {
          opts.onLog(`${slug}: WARNING — identity ${ids.identityId} teardown failed (leaked)`);
        }
      }
      if (ids.repoId) {
        try {
          await freestyle.git.repos.delete({ repoId: ids.repoId });
        } catch {
          opts.onLog(`${slug}: WARNING — Freestyle Git repo ${ids.repoId} teardown failed (leaked)`);
        }
      }
    }
  }

  return result;
}
