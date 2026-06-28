# Creating trails on a VM using Freestyle.sh

## How we use it

Our product ("hosted trail authoring") imports a user's GitHub repo into a
Freestyle Git repo. We then run an agent on a Freestyle VM so it can read files and make a trail.


```ts
import { freestyle } from 'freestyle'; // reads FREESTYLE_API_KEY

// 1. Import the GitHub repo into Freestyle Git
const { repoId } = await freestyle.git.repos.create({
  name: `authoring-${owner}-${repo}`,
  source: {
    url: `https://x-access-token:${userToken}@github.com/${owner}/${repo}.git`,
  },
});

// 2. Create Identity.
const { identityId } = await freestyle.identities.create();
const ident = freestyle.identities.ref({ identityId });
await ident.permissions.git.grant({ repoId, permission: 'read' });
const { token: gitToken } = await ident.tokens.create();

// 3. Clone in-VM from git.freestyle.sh/{repoId}:
//    git clone --depth 1 https://x-access-token:${gitToken}@git.freestyle.sh/${repoId} /work

// 4. Run the agent, publish on the host, then tear everything down.
await freestyle.vms.delete({ vmId });
await freestyle.identities.delete({ identityId });
await freestyle.git.repos.delete({ repoId });
```

We use Freestyle's documented source-import call shape
([docs.freestyle.sh/git/repositories](https://www.freestyle.sh/docs/git/repositories)):
a `.git` URL and the documented `rev` field — nothing beyond the documented
surface.

```js
await freestyle.git.repos.create({
  source: { url: "https://github.com/user/repo.git", rev: "main" },
});
```

`create({ source })` returns a `repoId` immediately; population is asynchronous
on Freestyle's side. We treat `git.repos.ref({ repoId }).branches.list()`
succeeding as the readiness signal — it's the same state a VM clone depends on:
while it errors, a clone of `git.freestyle.sh/{repoId}` returns HTTP 500. The
in-VM clone runs with a retry/backoff (8 attempts, 4s apart) to ride out the
import-vs-clone race.

## Resource lifecycle

Each authoring session creates three Freestyle resources — a **git repo**, an
**identity**, and a **VM** — and is responsible for tearing all three down (step
4). Teardown must run on every exit path, including failures, or the resources
leak. Note that `git.repos.create({ source })` counts the repo from the moment
the call starts server-side, so a create that throws or times out before
returning a `repoId` can leave a repo with no handle to delete.

## Known import limitations

Some imports never populate: `create({ source })` returns a `repoId`, but
`branches.list()` on it returns `INTERNAL_ERROR` and a clone of
`git.freestyle.sh/{repoId}` returns HTTP 500 — indefinitely, not a race. We
don't have a model for *why* a given repo fails, so we track it empirically as a
known-good / known-bad list.

| import path | result |
|---|---|
| `source` git import (**what authoring uses**) | works for most repos; fails for some (see below) |
| `tar` URL import (codeload & api.github, ±`dir`) | fails for every repo tried, including small ones |
| `zip` URL import (codeload) | fails for every repo tried, including small ones |
| `files` inline import | works |
| empty `create` | works |

Repos we've exercised on the `source` path:

- **Imports cleanly:** `sindresorhus/yocto-queue`, `expressjs/express`,
  `pierrecomputer/pierre`, `facebook/react`,
  `principal-ai/alexandria-core-library`, `principal-ai/strategy-planning`.
- **Fails to populate:** `anomalyco/opencode` (default branch `dev`),
  `pingdotgg/t3code`.

## The harness

Two ways to drive the same probes — a **browser UI** and a **CLI**. Both run a
*use case* over a list of repos, report a pass/fail per repo, and tear down
whatever they created.

Use cases (`src/use-cases.ts`):

- **`git-import`** — the production import path: `git.repos.create({ source })`
  → poll `branches.list()` until it populates. This is the one that **reproduces
  the import failures above**.
- **`vm-bash`** — boot a Freestyle VM, `git clone` the repo into it, and run a
  bash command via `vm.exec()`. Verifies the building block behind a curl-able
  `/<owner>/<repo>/bash` endpoint: a VM can shell out against a cloned repo and
  return stdout.

Each use case follows the same create → use → teardown shape, so adding one in
`src/use-cases.ts` surfaces it in both the UI and the CLI with no extra wiring.

### UI — spin it up to run the test cases (recommended)

The fastest way to **recreate the issues** is the local UI — pick a use case,
add the repos to exercise, and run, no CLI or docs needed:

```sh
cp .env.example .env   # add FREESTYLE_API_KEY (+ GITHUB_TOKEN for private repos)
npm install
npm run serve          # → http://localhost:4799
```

Then in the browser:

- Pick a **use case** (Git source import / VM bash exec).
- **Add repos** — paste `owner/repo`, `owner/repo@rev`, or a full GitHub URL
  (`https://github.com/owner/repo`, incl. `/tree/<branch>`). The list lives in
  your browser (localStorage); **Save to file** persists it to `repos.json`.
- **Run all**, or ▶ a single repo. Logs stream live and each result row shows
  status, timing, and trace id. A `!` flags any outcome that contradicts the
  expectation set for that repo.
- **Recreate the import failure:** select *Git source import*, add
  `anomalyco/opencode@dev` or `pingdotgg/t3code`, and run — you'll get
  `INTERNAL_ERROR` with a fresh trace id, while a clean repo populates in the
  same table for contrast.
- **Run command in VM:** open a warm VM for a repo and run ad-hoc commands
  against `/repo` (e.g. `git rev-parse HEAD`, `git log --oneline -5`) to inspect
  what an import/clone actually resolved to. Stop the VM when you're done.

### CLI

The same probes, headless — good for scripting and as a regression guard: it
exits non-zero if any observed outcome contradicts the expectation in
`src/repos.ts`.

```sh
npm run repro                                       # git-import, default repo set
npm run repro -- --use-case vm-bash                 # the VM bash-exec probe
npm run repro -- --repo anomalyco/opencode@dev      # one repo (optional @rev or URL)
npm run repro -- --window 60 --json results/run.json
```

Flags: `--use-case <id>`, `--repo owner/repo[@rev]` (repeatable; GitHub URLs
accepted), `--window <secs>` / `--interval <secs>` (readiness poll),
`--no-teardown`, `--json <path>`.

### Layout

- `src/repos.ts` — the default repo set + expected outcome per repo.
- `src/use-cases.ts` — the use-case registry (`git-import`, `vm-bash`).
- `src/probe.ts` — the git-import create → poll → teardown probe.
- `src/vm-bash.ts` — the VM create → clone → exec → teardown probe.
- `src/repro.ts` — CLI: runs a use case over the repo list; table + `--json`.
- `src/server.ts` + `public/index.html` — the browser UI.
