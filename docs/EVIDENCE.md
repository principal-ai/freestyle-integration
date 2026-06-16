# Evidence — live repro run

A captured run of `npm run repro` against the live Freestyle API, via
`freestyle@0.1.63`, exercising the production `source` import path. See
[`README.md`](../README.md) for what the harness does and how to reproduce.

- **Captured:** 2026-06-15T04:54:36Z
- **SDK:** `freestyle@0.1.63`
- **Readiness poll:** `branches.list()`, 45s window, 3s interval
- **Per repo:** `git.repos.create({ source: { url, rev } })`, then poll until
  populated or the window elapses, then teardown.

## Result

| repo | rev | create | outcome | populate / traceId |
|---|---|---:|---|---|
| `sindresorhus/yocto-queue` | main | 1226 ms | ✅ populated | 217 ms |
| `expressjs/express` | master | 2438 ms | ✅ populated | 1422 ms |
| `pierrecomputer/pierre` | main | 9119 ms | ✅ populated | 16507 ms |
| `facebook/react` | main | 48940 ms | ✅ populated | 28701 ms |
| `anomalyco/opencode` | dev | 52395 ms | ❌ `INTERNAL_ERROR` | traceId `2d962305-d341-4002-a301-8e9af788f494` |
| `pingdotgg/t3code` | main | 22466 ms | ❌ `INTERNAL_ERROR` | traceId `bb402cfd-947c-4225-8841-8322e5dde688` |

Every repo matched its prior-investigation expectation (no `!` mismatch flags).

## What this shows

- **`git.repos.create({ source })` returns a `repoId` for the failing repos**
  (after a notably long create — 52s / 22s), but the repo **never populates**:
  `branches.list()` returns `INTERNAL_ERROR` for the entire 45s window, with a
  fresh `traceId` each run. While `branches.list()` is `INTERNAL_ERROR`, a clone
  of `git.freestyle.sh/{repoId}` returns HTTP 500.
- **Not size alone.** `facebook/react` is large and took the *longest* to create
  (48.9 s) yet populated fine (28.7 s). `pierre` (~60 MB) populated. Only
  `opencode` (~283 MB) and `t3code` (~178 MB) fail.
- **Not the default branch.** `opencode` defaults to `dev`; importing `dev`
  explicitly still fails.
- **Not infra-wide.** Four repos populated in the same run that two failed.

## Fresh traceIds for Freestyle

```
anomalyco/opencode@dev   INTERNAL_ERROR   2d962305-d341-4002-a301-8e9af788f494
pingdotgg/t3code@main    INTERNAL_ERROR   bb402cfd-947c-4225-8841-8322e5dde688
```

Re-run `npm run repro -- --json results/run.json` for a fresh set (traceIds and
timings vary per run; `results/` is gitignored).
