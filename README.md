# Freestyle Git import — reproduction & evidence

A minimal, self-contained repo to reproduce a server-side import failure in the
[Freestyle](https://freestyle.sh) Git API (`freestyle@0.1.63`) and hand the
Freestyle team a clean evidence set. No VM, no application code, no secrets — a
GitHub repo URL in, create/populate timings + traceIds out.

> **Status:** runnable. A pure-SDK harness reproduces the production `source`
> import path against the live Freestyle API — see [Running](#running). It uses
> the SDK's first-class `git.repos.create({ source })` (the only import shape
> `freestyle@0.1.63` types), which is exactly what authoring uses.

---

## TL;DR for the Freestyle team

Importing a GitHub repo into Freestyle Git with `git.repos.create({ source })`
**reports success but never populates the repo** for certain inputs. The create
call returns a `repoId`, but `branches.list()` on that repo returns
`INTERNAL_ERROR` and any clone of `git.freestyle.sh/{repoId}` returns HTTP 500.

We see **two distinct failures**, possibly sharing one server-side fetch/pack
subsystem:

1. **Large-repo `source` import** — small/medium repos import fine; large repos
   (e.g. `anomalyco/opencode` ~283 MB, `pingdotgg/t3code` ~178 MB) never
   populate. Note `facebook/react` (also large) imports fine, so it is **not
   size alone** — see [What we ruled out](#what-we-ruled-out).
2. **All URL-based archive imports** (`tar` / `zip`) — fail for *every* repo
   tried, including a tiny one (`pierrecomputer/pierre`).

`files` inline import and empty `create` always succeed.

---

## How we use the library

Our product ("hosted trail authoring") imports a user's GitHub repo into a
fresh Freestyle Git repo **server-side**, so that a Freestyle VM can then clone
it **in-network** from Freestyle Git. The user's GitHub token stays on the host
— it authenticates the import and never enters the VM.

The full flow (reference: `web-ade/src/lib/authoring/env/freestyle.ts`):

```ts
import { freestyle } from 'freestyle'; // reads FREESTYLE_API_KEY

// 1. Import the GitHub repo into Freestyle Git — SERVER-SIDE. Freestyle fetches
//    from github.com on its own network. THIS is the call that fails.
const { repoId } = await freestyle.git.repos.create({
  name: `authoring-${owner}-${repo}`,
  source: {
    url: `https://x-access-token:${userToken}@github.com/${owner}/${repo}.git`,
    rev: ref ?? null, // branch/tag/sha; null → the repo's default branch
  },
});

// 2. Mint a scoped, read-only identity token so the VM can clone in-network.
const { identityId } = await freestyle.identities.create();
const ident = freestyle.identities.ref({ identityId });
await ident.permissions.git.grant({ repoId, permission: 'read' });
const { token: gitToken } = await ident.tokens.create();

// 3. Clone in-VM from git.freestyle.sh/{repoId}:
//    git clone --depth 1 https://x-access-token:${gitToken}@git.freestyle.sh/${repoId} /work
//    → fails with: fatal: unable to access '.../': The requested URL returned error: 500

// 4. (omitted here) run the agent, publish on the host, then tear everything down:
await freestyle.vms.delete({ vmId });
await freestyle.identities.delete({ identityId });
await freestyle.git.repos.delete({ repoId });
```

The break is at **step 1**. `create({ source })` resolves with a `repoId`, but
the repo behind it is never populated: `git.repos.ref({ repoId }).branches.list()`
returns `INTERNAL_ERROR`, and the step-3 clone gets HTTP 500.

In production we added a retry/backoff around the clone (8 attempts, 4s apart)
on the theory that import is asynchronous and the clone was racing it. For the
failing repos the repo **never** populates — the retries just burn ~32s before
surfacing `UNAVAILABLE`.

---

## What we ruled out

Tested directly against the Freestyle SDK (`freestyle@0.1.63`), the failure is
**not** in our code, the VM clone, VM egress, the user's GitHub token, or a
`ref` / default-branch detection bug:

- **Not size alone** — `facebook/react` (large) imports fine; `pierre` (60 MB)
  imports fine. Yet `opencode` (283 MB) and `t3code` (178 MB) never populate.
- **Not a non-`main` default branch** — `anomalyco/opencode` defaults to `dev`;
  passing `rev: 'dev'` explicitly fails identically.
- **Not our token** — the token authenticates (`GET /user` → 200) and a GitHub
  API `resolveSha` succeeds for every repo that later fails to import.
- **Not infra-wide degradation** — `express` / `pierre` / `react` import during
  the same runs in which `opencode` / `t3code` fail.

---

## Reproduction matrix (observed)

Ingestion path × repo, via `git.repos.create`:

| path | small/medium repo | large repo (opencode 283 MB, t3code 178 MB) |
|---|---|---|
| `source` git import (**what authoring uses**) | OK (express 6.6s, pierre 11.9s, react ~30s) | **INTERNAL_ERROR — never populates** |
| `tar` URL import (codeload & api.github, ±`dir`) | **INTERNAL_ERROR (even tiny pierre)** | INTERNAL_ERROR |
| `zip` URL import (codeload) | **INTERNAL_ERROR (even tiny pierre)** | INTERNAL_ERROR |
| `files` inline import | OK | n/a |
| empty create | OK | n/a |

## Repos exercised

- **Import OK:** `expressjs/express` (9.8 MB), `pierrecomputer/pierre` (60 MB),
  `sindresorhus/yocto-queue`, `facebook/react` (large).
- **Import FAILS (`source`):** `anomalyco/opencode` (283 MB, default branch
  `dev`), `pingdotgg/t3code` (178 MB, `main`). Not forks of each other.

## Evidence captured so far

- Exact VM symptom reproduced host-side:
  `fatal: unable to access 'https://git.freestyle.sh/{repoId}/': The requested URL returned error: 500`.
- Freestyle `traceId`s from failing `branches.list()` calls
  (e.g. `e9d2beac-969c-4a3a-8d96-1794938ca23c`). We will capture **fresh**
  traceIds + timestamps in the repro run below.

---

## The harness

A pure-SDK CLI (`src/`) that, for each repo, does exactly what authoring does at
the point of failure — and nothing else (no VM, no opencode, no git binary):

1. `git.repos.create({ source: { url, rev } })` — server-side import; record
   create time + `repoId`. This is Freestyle's **exactly documented** call shape
   (see [below](#matches-the-documented-api)) — no undocumented options.
2. Poll `git.repos.ref({ repoId }).branches.list()` until the repo is readable
   (populated) or the window elapses. `branches.list()` is the same readiness
   signal a VM clone depends on — while it returns `INTERNAL_ERROR`, a clone of
   `git.freestyle.sh/{repoId}` returns HTTP 500. The SDK error carries a fresh
   `traceId` (from the `x-freestyle-trace-id` header).
3. Tear the Freestyle repo down (always, unless `--no-teardown`).

It deliberately covers the **one production path** (`source`). Bug 2 (tar/zip
URL imports) isn't a first-class shape in the `0.1.63` SDK and is documented
above from the original investigation.

- `src/repos.ts` — the default repro set (the exact investigation repos + their
  expected outcome). Outcomes that contradict the expectation are flagged `!`
  and make the run exit non-zero — so this doubles as a regression check once
  Freestyle ships a fix.
- `src/probe.ts` — the create → poll → teardown probe.
- `src/repro.ts` — CLI, table output, optional `--json`.

## Running

```sh
cp .env.example .env   # add FREESTYLE_API_KEY (+ GITHUB_TOKEN for private repos)
npm install
npm run repro                                   # the default investigation set
npm run repro -- --repo anomalyco/opencode@dev  # one repo (optional @rev)
npm run repro -- --window 60 --json results/run.json
```

Flags: `--repo owner/repo[@rev]` (repeatable), `--window <secs>` /
`--interval <secs>` (readiness poll), `--no-teardown`, `--json <path>`.

## Matches the documented API

The harness uses Freestyle's own documented source-import call verbatim
([docs.freestyle.sh/git/repositories](https://www.freestyle.sh/docs/git/repositories)):

```js
await freestyle.git.repos.create({
  source: { url: "https://github.com/user/repo.git", rev: "main" },
});
```

That is: a `.git` URL and the documented **`rev`** field — nothing beyond the
documented surface. The import still fails identically, so the bug reproduces
with Freestyle's exact documented usage.

`.env` is gitignored; only `.env.example` is committed. No secret is written to
a committed file or printed in output.
