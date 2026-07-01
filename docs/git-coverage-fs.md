# Git ownership map over Freestyle Git (`git-coverage-fs`)

Can we build the contributor **ownership map** for a repo by routing it through
**Freestyle Git** — the hosted import product — instead of cloning directly from
GitHub onto the VM? This use case tests that path end to end and records what we
found.

It's the same in-VM `git blame` sweep as [`git-coverage`](../src/git-coverage.ts);
only the *source of the clone* changes. So any difference in the result is
attributable to the Freestyle Git import path, which is the whole point.

## What it does

`src/git-freestyle.ts` (use case id `git-coverage-fs`) runs the production
hosted-authoring shape:

1. **Import** — `git.repos.create({ source: { url, rev } })` imports the GitHub
   repo into a hosted Freestyle Git repo; poll `branches.list()` until it
   populates (or the window elapses).
2. **Scope a token** — `identities.create()` →
   `permissions.git.grant({ repoId, 'read' })` → `tokens.create()`: a read-only
   identity token the VM clones with.
3. **Clone + sweep** — `vms.create()` → clone
   `https://x-access-token:<token>@git.freestyle.sh/<repoId>` (**full history**,
   blame needs it) → run the identical `git-coverage` blame sweep → read the
   ownership map JSON back.
4. **Teardown** — delete **all three** resources (VM, identity, Freestyle Git
   repo), each independently and best-effort.

Output is the same `OwnershipMap` shape as `git-coverage`
(`byEmail` / `totalLines` / `totalLinesGlobal` / `contributors`), written to
`results/coverage-fs-<owner>-<repo>.json`. The `-fs-` marker keeps it from
colliding with the direct-clone `git-coverage` output, so you can diff the two
for the same repo.

## Running it

```sh
# One repo, generous window (import + full-history clone of a big repo is slow).
npm run repro -- --use-case git-coverage-fs --repo rhyssullivan/executor --window 360

# Several at once (they run sequentially).
npm run repro -- --use-case git-coverage-fs \
  --repo LadybirdBrowser/ladybird --repo elastic/kibana \
  --window 360 --interval 5 --json results/run-covfs-batch.json
```

Reads `FREESTYLE_API_KEY` (required) and `GITHUB_TOKEN` (optional, for private
repos / to dodge the anonymous GitHub rate limit) from `.env`. It's also
selectable in the browser UI (`npm run serve`) like every other use case.

## Findings

Verified against these repos:

| repo | outcome | detail |
|---|---|---|
| `rhyssullivan/executor` | ✅ **coverage ok** | 1768 files, 26 authors, 877,865 lines in ~67s — full pipeline worked |
| `anomalyco/opencode` | ❌ import never populated | `branches.list()` → **Internal server error** for the whole window (5 polls / 240s) |
| `LadybirdBrowser/ladybird` | ❌ `fetch failed` (sweep) | import populated, VM cloned, but clone + blame ran past the client timeout (~578s) |
| `elastic/kibana` | ❌ `fetch failed` (create) | the `git.repos.create({ source })` call itself didn't return within the client timeout (~301s) |

Two conclusions:

- **The path works, and Freestyle Git preserves full history.** `executor` is
  the positive proof: import → token → clone → blame produced a real ownership
  map. Blame *requires* full commit history, so the import is not tip-only.
- **Two distinct failure modes, only one of which is Freestyle's import bug.**
  - `opencode` is the known **import bug**: `create({ source })` returns a
    `repoId` but the repo never populates (`INTERNAL_ERROR`) — the same failure
    the [`git-import`](../src/probe.ts) probe reproduces. The ownership map is
    blocked at step 1 and never reaches the VM. (This repo *does* clone directly
    from GitHub, which is why the integration uses the VM-clone path.)
  - `ladybird` and `kibana` are **client-side `fetch failed`** transport
    timeouts on the two giant repos — undici's default header/connect timeouts,
    which neither this harness nor the SDK overrides (same caveat noted in
    `probe.ts`). `ladybird` timed out holding the `vm.exec` clone connection
    open; `kibana` timed out on the import-create call before returning a
    `repoId`. These are *our-side* limits, not the `INTERNAL_ERROR` bug.

## Caveats

- **Large repos need a longer client fetch timeout.** The `fetch failed` results
  above are undici defaults giving up on a long-running request, not a Freestyle
  error. Raising the fetch timeout (or streaming/polling the clone instead of
  holding one `vm.exec` open) is the fix, and lives on our side.
- **A create that times out can orphan a repo.** `git.repos.create({ source })`
  counts the repo server-side from the moment the call starts, so `kibana`'s
  timed-out create may have left a Freestyle Git repo that's invisible to
  `git.repos.list()` (which reported 0) yet still counts as active — and we have
  no `repoId` to delete it. See the orphan/billing note in the main README.
