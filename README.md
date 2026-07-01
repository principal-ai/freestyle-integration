# Repo git analysis on Freestyle VMs

## What this does

We need two pieces of data for a GitHub repo to drive web-ade's File City map:

- **A contributor ownership map** — which contributor owns how many lines of
  which file (`git blame` at HEAD). web-ade highlights a contributor's coverage
  from this.
- **Per-file line counts** — the newline count of every tracked text file.
  web-ade turns these into 3D building heights.

This repo produces both by **running a git sweep on a Freestyle VM** — one script
that sweeps local disk and prints aggregated JSON, mirroring the electron-app's
`GitService.getOwnershipMap` and `GitRepositoryService.countLinesInRepository`
shape-for-shape, so it drops into web-ade's existing rendering with no
translation layer.

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

**Step 3 — VM clone from `git.freestyle.sh`**

- **Large clones hit client-side timeouts.** `ladybird` cloned past the client
  fetch timeout (undici defaults, which the SDK doesn't override) and failed with
  `fetch failed`. This is a client-side limit, addressable on our side — not an
  `INTERNAL_ERROR`.

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
// Boot a throwaway VM, clone straight from GitHub, sweep, discard.
const { vm, vmId } = await freestyle.vms.create({ persistence: { type: 'ephemeral' } });
await vm.exec({ command: `git clone https://github.com/${owner}/${repo}.git /repo` });
const { stdout } = await vm.exec({ command: 'python3 /tmp/sweep.py /repo' });
await vm.delete({ vmId });
```

This is the `git-coverage` / `git-linecount` path: it sidesteps every step-1 issue
above. The `git-coverage-fs` path stays in the repo so we can re-verify the
Freestyle-native flow as the import issues get fixed.

## The key design: one sweep per VM, not one exec per file

Every `vm.exec()` is a network round-trip to Freestyle. The electron-app runs one
`git blame` per file via an in-process git API — fine locally, but replaying that
over `vm.exec` would be thousands of round-trips and gigabytes of raw blame
output. Instead, each use case pushes **one** script into the VM that does the
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
  the `contributors` list. Mirrors `getOwnershipMap`. Needs full history (blame
  can't run against a shallow clone). Written to
  `results/coverage-<owner>-<repo>.json`.
- **`git-linecount`** — shallow clone + in-VM line-count sweep → `{ lineCounts,
  fileCount }`, the exact body the app PUTs to the web-ade line-counts cache.
  Mirrors `countLinesInRepository` (same binary-extension skip, 1 MB cap, and
  newline rule). Shallow is enough — line counts read the working tree at HEAD.
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
