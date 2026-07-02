# Repo git analysis on Freestyle VMs

## What this does

We need two pieces of data for a GitHub repo to drive web-ade's File City map:

- **A contributor ownership map** — which contributor owns how many lines of
  which file (`git blame` at HEAD). web-ade highlights a contributor's coverage
  from this.
- **Per-file line counts** — the newline count of every tracked text file.
  web-ade turns these into 3D building heights.

This repo produces both by **running a git sweep on a Freestyle VM** — one script
that sweeps local disk and prints the aggregated result as JSON.

The open question is **how the repo should get onto that VM**. Freestyle gives us
two routes — its hosted Git import, and a direct clone — and this repo exercises
both. Below is the Freestyle-native flow we think we *should* use, the issues we
hit trying to run it end to end, and the direct-clone path we fall back on today.

## How we think this should work with Freestyle

The Freestyle-native path treats **Freestyle Git as the source of truth**: import
the GitHub repo into a hosted Freestyle Git repo, mint a scoped token, and have a
throwaway VM clone from it and sweep. This is the `git-coverage-fs` use case.

```ts
import { freestyle } from 'freestyle'; // reads FREESTYLE_API_KEY

// 1. Import the GitHub repo into Freestyle Git; poll until it populates.
const { repoId } = await freestyle.git.repos.create({
  source: { url: `https://github.com/${owner}/${repo}.git`, rev },
});
await freestyle.git.repos.ref({ repoId }).branches.list(); // readiness signal

// 2. Mint a scoped, revocable read token for the VM to clone with.
const { identityId } = await freestyle.identities.create();
const ident = freestyle.identities.ref({ identityId });
await ident.permissions.git.grant({ repoId, permission: 'read' });
const { token } = await ident.tokens.create();

// 3. Boot a VM, clone from git.freestyle.sh, run the WHOLE sweep in one exec.
const { vm, vmId } = await freestyle.vms.create({ persistence: { type: 'ephemeral' } });
await vm.exec({ command: `git clone https://x-access-token:${token}@git.freestyle.sh/${repoId} /repo` });
const { stdout } = await vm.exec({ command: 'python3 /tmp/sweep.py /repo' });
const ownershipMap = JSON.parse(stdout); // { byEmail, totalLines, contributors, ... }

// 4. Tear down all three resources — VM, identity, Freestyle Git repo.
await vm.delete({ vmId });
await freestyle.identities.delete({ identityId });
await freestyle.git.repos.delete({ repoId });
```

Why this shape: Freestyle Git is the hosted source of truth, the scoped token
keeps the VM's access read-only and revocable, and the analysis is one sweep per
VM (below) so only KB–MB of JSON crosses the wire.

## Issues we've hit, by step

We can't yet run the path above end to end on every repo. The failures cluster by
step:

**Step 1 — import (`git.repos.create({ source })`)**

- **Never populates on some repos.** `create` returns a `repoId`, but
  `branches.list()` returns `INTERNAL_ERROR` and a clone of
  `git.freestyle.sh/{repoId}` returns HTTP 500 — indefinitely, not a race.
  Reproduced on `anomalyco/opencode@dev` and `pingdotgg/t3code`; both clone
  cleanly straight from GitHub, so it isn't the repo. (Repro: `git-import`.)
- **Create can time out before returning a `repoId`.** On very large repos
  (`elastic/kibana`) the call didn't return within the client timeout — and since
  the repo counts server-side from the moment the call starts, this can orphan a
  repo we then have no id to delete.
- **`tar` / `zip` URL import variants fail for every repo tried**, including small
  ones. Only `source` git import and `files` / empty `create` work at all.

**Step 1 readiness — `branches.list()`**

- **`populated` can report early.** On `LadybirdBrowser/ladybird`,
  `branches.list()` succeeded on the first poll (instantly) for a very large repo
  that then failed at clone — the readiness signal may fire before objects finish
  importing.

**Step 3 — VM clone (large repos)** — *resolved on our side*

- **Large clones used to hit client-side timeouts.** Holding one long `vm.exec()`
  open for a big clone (`ladybird`) hit undici's default fetch timeout and failed
  with `fetch failed`. Fixed by following Freestyle's documented long-running
  pattern: launch the clone as a transient `systemd-run` unit and poll a marker
  file with short calls (`execLong` in `src/vm-bash.ts`). The `ladybird`
  full-history clone now completes (exit 0).
- **Long jobs need a *persistent* VM, not ephemeral.** With the detached pattern a
  long job can suspend mid-run; an **ephemeral** VM loses its disk on suspend
  (`VM files have been deleted`), so the cloned `/repo` vanishes before the sweep.
  Switching to `persistence: { type: 'persistent' }` fixed it. (A full-history
  blame of a repo as large as `ladybird` is still just slow — >30 min — but that's
  compute time, not an infra failure.)

**Step 4 — teardown**

- **Never-populated repos may not delete cleanly.** `git.repos.delete()` can
  report success while the repo stays invisible to `git.repos.list()` — an orphan
  that may still count as active.

Verified good vs. bad on the import path:

| import path | result |
|---|---|
| `source` git import | works for most repos; fails for some (above) |
| `tar` URL import (codeload & api.github, ±`dir`) | fails for every repo tried |
| `zip` URL import (codeload) | fails for every repo tried |
| `files` inline import | works |
| empty `create` | works |

- **Imports cleanly:** `sindresorhus/yocto-queue`, `expressjs/express`,
  `pierrecomputer/pierre`, `facebook/react`, `rhyssullivan/executor`,
  `principal-ai/alexandria-core-library`, `principal-ai/strategy-planning`.
- **Fails to populate:** `anomalyco/opencode` (default branch `dev`),
  `pingdotgg/t3code`.

## What runs today

Until step 1 is reliable, the working integration **skips Freestyle Git and clones
the repo directly from GitHub onto the VM** — same sweep, same output, no
hosted-repo lifecycle to manage:

```ts
// Boot a VM, clone straight from GitHub, sweep, discard. Persistent (not
// ephemeral) so a long clone/sweep survives a mid-run suspend; the long clone
// runs via the systemd-unit + marker-poll pattern (see Step 3).
const { vm, vmId } = await freestyle.vms.create({
  persistence: { type: 'persistent' },
  idleTimeoutSeconds: null,
});
await execLong(vm, 'clone', `git clone https://github.com/${owner}/${repo}.git /repo`, { windowSecs });
const { stdout } = (await execLong(vm, 'sweep', 'python3 /tmp/sweep.py /repo', { windowSecs }));
await vm.delete();
```

This is the `git-coverage` / `git-linecount` path: it sidesteps every step-1 issue
above. The `git-coverage-fs` path stays in the repo so we can re-verify the
Freestyle-native flow as the import issues get fixed.

## Warm VMs: how we cache today

The harness in this repo is deliberately throwaway — create → clone → sweep →
delete — to keep each probe isolated. Our actual usage caches differently, and
this is the context we'd like Freestyle's advice on:

- **One VM per repo, kept *suspended*.** The first visit clones the repo onto a
  VM; we then **suspend** it rather than delete it. A later visit **resumes** the
  same VM with the repo already on disk — no re-clone. For a repo whose clone
  takes minutes, that's the difference between instant and slow.
- **The suspended VMs double as a visited registry** — the set of them *is* the
  list of repos we've processed; there's no separate index.
- **We clone directly from GitHub — we do not use Freestyle Git today.** The
  `git-coverage-fs` path here is us evaluating whether routing through Freestyle
  Git would be better.

Suspend appears cheap and works well. The open question is whether a different
Freestyle primitive — a per-repo **snapshot**, or fast cloning from Freestyle Git
— would start faster or track state more cleanly (see *Open questions* below).

## The key design: one sweep per VM, not one exec per file

Every `vm.exec()` is a network round-trip to Freestyle. Running one `git blame`
per file would be the obvious port and the wrong one: thousands of round-trips
and gigabytes of raw blame output crossing the wire. Instead, each use case
pushes **one** script into the VM that does the
whole sweep against local disk and prints **aggregated** JSON. One round-trip,
KB–MB of output. This is the load-bearing decision in `git-coverage.ts` and
`git-linecount.ts`.

## The use cases

Both the CLI (`repro.ts`) and the browser UI run a *use case* over a list of
repos, report pass/fail per repo, and tear down whatever they created. Adding one
in `src/use-cases.ts` surfaces it in both with no extra wiring.

**What runs today — direct GitHub clone:**

- **`git-coverage`** — full clone + in-VM `git blame` sweep → the **ownership
  map**: `byEmail` (email → file → lines), `totalLines`, `totalLinesGlobal`, and
  the `contributors` list. Needs full history (blame can't run against a shallow
  clone). Written to `results/coverage-<owner>-<repo>.json`.
- **`git-linecount`** — shallow clone + in-VM line-count sweep → `{ lineCounts,
  fileCount }`: a newline count per tracked text file, skipping binaries and
  files over 1 MB. Shallow is enough — line counts read the working tree at HEAD.
  Written to `results/linecount-<owner>-<repo>.json`.

**The Freestyle-native path we want:**

- **`git-coverage-fs`** — the same ownership map as `git-coverage`, but the repo
  reaches the VM through **Freestyle Git**: import → scoped token → VM clone from
  `git.freestyle.sh` → identical blame sweep → three-resource teardown. Verified
  end to end on `rhyssullivan/executor` (and confirms the import preserves full
  history — blame works). Written to `results/coverage-fs-<owner>-<repo>.json`.
  See [docs/git-coverage-fs.md](docs/git-coverage-fs.md).

**Probes (Freestyle building blocks / bug repro):**

- **`vm-bash`** — boot a VM, `git clone` the repo, run a bash command via
  `vm.exec()`. The minimal "a VM can shell out against a cloned repo" check.
- **`git-import`** — the production import path: `git.repos.create({ source })`
  → poll `branches.list()` until it populates. **Reproduces the step-1 import
  failures** above.

### Output shapes

`git-coverage` → `OwnershipMap` (see `src/git-coverage.ts`):

```ts
{
  byEmail: Record<email, Record<path, linesOwned>>;  // contributor coverage
  totalLines: Record<path, number>;                  // blamed lines per file
  totalLinesGlobal: number;
  contributors: Array<{ name: string; commits: number; email: string }>;
}
```

`git-linecount` → `LineCountMap` (see `src/git-linecount.ts`):

```ts
{
  lineCounts: Record<path, number>;  // newline count per tracked text file
  fileCount: number;
}
```

> **Heights vs ownership use different counts.** `git-linecount`'s newline count
> is the true file line count (verified: yocto-queue `index.js` = 90). The
> `totalLines` in `git-coverage` is a `git blame` total and runs ~10% lower, so
> use `git-linecount` for any height or "% of file" math, and `git-coverage`
> only for *who* owns *which* files.

## Running it

### UI (recommended)

```sh
cp .env.example .env   # add FREESTYLE_API_KEY (+ GITHUB_TOKEN for private repos)
npm install
npm run serve          # → http://localhost:4799
```

In the browser: pick a **use case**, **add repos** (`owner/repo`,
`owner/repo@rev`, or a GitHub URL), and **Run all** or ▶ a single repo. Logs
stream live; each result row shows status, timing, and trace id. The repo list
lives in your browser (localStorage); **Save to file** persists it to
`repos.json`.

### CLI

```sh
npm run repro -- --use-case git-coverage    --repo expressjs/express --window 300
npm run repro -- --use-case git-linecount   --repo expressjs/express --window 120
npm run repro -- --use-case git-coverage-fs --repo rhyssullivan/executor --window 360  # Freestyle-native
npm run repro -- --use-case git-import      --repo anomalyco/opencode@dev   # bug repro
npm run repro                                                               # git-import, default set
```

Flags: `--use-case <id>`, `--repo owner/repo[@rev]` (repeatable; GitHub URLs
accepted), `--window <secs>` / `--interval <secs>`, `--no-teardown`,
`--json <path>`. The CLI exits non-zero if any observed outcome contradicts the
expectation in `src/repos.ts`, so it doubles as a regression guard.

Reads `FREESTYLE_API_KEY` (required) and `GITHUB_TOKEN` (optional, for private
repos / to dodge the anonymous rate limit) from `.env`.

## Open questions for Freestyle

Guidance welcome — some are gaps, some are "are we holding it right?"

1. **Warm start: suspended VM vs snapshot vs Freestyle Git clone?** Today we keep
   one **suspended VM per repo** so a revisit resumes with the repo already on
   disk (no re-clone). Would a per-repo **VM snapshot** (`vm.snapshot()` →
   `vms.create({ snapshotId })`) be a better warm cache? It looks like it would
   give instant fresh VMs *and* parallel fan-out (many VMs from one image), which a
   single suspended VM can't. How do the two compare on **start latency** and on
   **cost** (a suspended VM's disk vs a snapshot's storage)?
2. **Would cloning from Freestyle Git be materially faster than from GitHub?**
   Enough to clone fresh on every VM and drop warm caches entirely? We haven't
   measured `git clone git.freestyle.sh/<repoId>` against `git clone github.com/…`.
3. **How do we know when a `create({ source })` import has finished?** We found no
   documented status field, readiness endpoint, or completion webhook (the only
   webhook is for pushes). We poll `branches.list()` as a proxy, but it reports
   ready *early* on large repos (Step 1 readiness above). A real import-completion
   signal would remove the guesswork.
4. **Is the `systemd-run` + marker-file pattern the recommended way to run long
   commands?** We adopted it (from your sandbox guides) after single long
   `vm.exec()` calls hit client-side fetch timeouts on big clones. Is there a
   native long-exec / streaming / poll API we should prefer?
5. **Import reliability.** Some repos never populate (`INTERNAL_ERROR`), and a
   `create` that times out before returning a `repoId` can orphan a repo we can't
   delete. Known issues, or misuse of the API?

## Layout

- `src/repos.ts` — the default repo set + expected outcome per repo.
- `src/use-cases.ts` — the use-case registry (`git-coverage`, `git-linecount`,
  `vm-bash`, `git-import`, `git-coverage-fs`).
- `src/git-coverage.ts` — full clone → in-VM blame sweep → ownership map.
- `src/git-linecount.ts` — shallow clone → in-VM line-count sweep → line counts.
- `src/git-freestyle.ts` — import into Freestyle Git → token → VM clone from
  `git.freestyle.sh` → the same blame sweep. See
  [docs/git-coverage-fs.md](docs/git-coverage-fs.md) for what it tests and found.
- `src/vm-bash.ts` — VM create → clone → exec → teardown (+ shared `cloneCommand`).
- `src/probe.ts` — the git-import create → poll → teardown probe.
- `src/repro.ts` — CLI: runs a use case over the repo list; table + `--json`.
- `src/server.ts` + `public/index.html` — the browser UI.
- `results/` — per-repo output JSON from the coverage / line-count sweeps.
