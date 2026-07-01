# Repo git analysis on Freestyle VMs

## What this does

We need two pieces of data for a GitHub repo to drive web-ade's File City map:

- **A contributor ownership map** — which contributor owns how many lines of
  which file (`git blame` at HEAD). web-ade highlights a contributor's coverage
  from this.
- **Per-file line counts** — the newline count of every tracked text file.
  web-ade turns these into 3D building heights.

This repo produces both by **cloning the repo onto a Freestyle VM and running a
git sweep inside it**, then reading structured JSON back. The output mirrors the
electron-app's `GitService.getOwnershipMap` and
`GitRepositoryService.countLinesInRepository` shape-for-shape, so it drops into
web-ade's existing rendering with no translation layer.

```ts
import { freestyle } from 'freestyle'; // reads FREESTYLE_API_KEY

// 1. Boot a throwaway VM and clone the repo onto it (token embedded host-side).
const { vm, vmId } = await freestyle.vms.create({ persistence: { type: 'ephemeral' } });
await vm.exec({ command: `git clone https://github.com/${owner}/${repo}.git /repo` });

// 2. Run the WHOLE sweep in one exec — it prints aggregated JSON to stdout.
const { stdout } = await vm.exec({ command: 'python3 /tmp/sweep.py /repo' });
const ownershipMap = JSON.parse(stdout); // { byEmail, totalLines, contributors, ... }

// 3. Tear the VM down regardless of outcome.
await vm.delete({ vmId });
```

### Why a VM clone, not Freestyle Git import

Freestyle has a separate **Git import** product (`git.repos.create({ source })`)
that pulls a GitHub repo into a hosted Freestyle Git server. We do **not** use it:
it returns `INTERNAL_ERROR` on some repos and never populates (see below). The
same repos `git clone` cleanly onto a VM — verified on `anomalyco/opencode@dev`
and `pingdotgg/t3code`, both of which fail the import path. The VM path also
needs no hosted-repo lifecycle: clone, analyze, return JSON, discard.

The import-failure repro still lives here (the `git-import` use case) as evidence
for the Freestyle bug, but it is not part of the integration.

### The key design: one sweep per VM, not one exec per file

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

**Integration data (the point of this repo):**

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

**Probes (Freestyle building blocks / bug repro):**

- **`vm-bash`** — boot a VM, `git clone` the repo, run a bash command via
  `vm.exec()`. The minimal "a VM can shell out against a cloned repo" check.
- **`git-import`** — the production import path: `git.repos.create({ source })`
  → poll `branches.list()` until it populates. **Reproduces the import failures**
  described above; not part of the integration.

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
npm run repro -- --use-case git-coverage  --repo expressjs/express --window 300
npm run repro -- --use-case git-linecount --repo expressjs/express --window 120
npm run repro -- --use-case git-import    --repo anomalyco/opencode@dev   # bug repro
npm run repro                                                             # git-import, default set
```

Flags: `--use-case <id>`, `--repo owner/repo[@rev]` (repeatable; GitHub URLs
accepted), `--window <secs>` / `--interval <secs>`, `--no-teardown`,
`--json <path>`. The CLI exits non-zero if any observed outcome contradicts the
expectation in `src/repos.ts`, so it doubles as a regression guard.

Reads `FREESTYLE_API_KEY` (required) and `GITHUB_TOKEN` (optional, for private
repos / to dodge the anonymous rate limit) from `.env`.

## Known import limitations (the `git-import` path)

Some imports never populate: `create({ source })` returns a `repoId`, but
`branches.list()` returns `INTERNAL_ERROR` and a clone of
`git.freestyle.sh/{repoId}` returns HTTP 500 indefinitely. Tracked empirically
as a known-good / known-bad list.

| import path | result |
|---|---|
| `source` git import | works for most repos; fails for some (below) |
| `tar` URL import (codeload & api.github, ±`dir`) | fails for every repo tried |
| `zip` URL import (codeload) | fails for every repo tried |
| `files` inline import | works |
| empty `create` | works |

- **Imports cleanly:** `sindresorhus/yocto-queue`, `expressjs/express`,
  `pierrecomputer/pierre`, `facebook/react`,
  `principal-ai/alexandria-core-library`, `principal-ai/strategy-planning`.
- **Fails to populate:** `anomalyco/opencode` (default branch `dev`),
  `pingdotgg/t3code`. **Both clone cleanly on a VM** — which is why the
  integration uses the VM path.

### Orphaned repos / billing note

Two things we observed while exercising the import path, worth flagging to the
Freestyle team:

- **A never-populated import may not delete cleanly.** For a repo stuck on
  `INTERNAL_ERROR`, `git.repos.delete()` can report success while the repo stays
  invisible to `git.repos.list()` — an orphan that may still count as active.
- **A create that times out can orphan a repo with no handle.**
  `git.repos.create({ source })` counts the repo server-side from the moment the
  call starts, so a create that throws or times out *before* returning a
  `repoId` (seen on very large repos like `elastic/kibana`) can leave a repo
  there's no id to delete.

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
