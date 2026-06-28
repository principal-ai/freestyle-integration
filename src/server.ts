/**
 * The harness UI server — a thin wrapper so the create→use→teardown probes can
 * be driven from a browser instead of the CLI. It holds the Freestyle API key
 * (which can't live in the browser) and exposes four endpoints:
 *
 *   GET  /api/use-cases   → [{ id, label, description }] for the picker
 *   GET  /api/repos       → the on-disk repo set (repos.json), seeded from
 *                           DEFAULT_REPOS the first time
 *   PUT  /api/repos       → persist a repo set to repos.json ("write to file")
 *   POST /api/run  (SSE)  → run a use case over a repo list, streaming each log
 *                           line and per-repo result as it happens
 *
 * The browser keeps its working repo list in localStorage; repos.json is the
 * explicit file it can save to / load from. Everything is local + unauthenticated
 * — this is a dev tool, not a hosted service.
 */
import './load-env.js'; // MUST be first — populates env before the SDK loads.
import express, { type Request, type Response } from 'express';
import { freestyle } from 'freestyle';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_REPOS, type RepoSpec } from './repos.js';
import { USE_CASES, getUseCase } from './use-cases.js';
import { cloneCommand, describeError } from './vm-bash.js';

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const REPOS_FILE = path.join(ROOT, 'repos.json');
const PORT = Number(process.env.PORT) || 4799;

/** Read repos.json; seed it from DEFAULT_REPOS on first run. */
function readRepos(): RepoSpec[] {
  try {
    return JSON.parse(readFileSync(REPOS_FILE, 'utf8')) as RepoSpec[];
  } catch {
    writeFileSync(REPOS_FILE, JSON.stringify(DEFAULT_REPOS, null, 2));
    return DEFAULT_REPOS;
  }
}

/** Validate + normalize an incoming repo list before persisting. */
function sanitizeRepos(input: unknown): RepoSpec[] {
  if (!Array.isArray(input)) throw new Error('expected an array of repos');
  return input.map((r, i) => {
    const o = r as Record<string, unknown>;
    if (typeof o.owner !== 'string' || typeof o.repo !== 'string') {
      throw new Error(`repo[${i}] needs string owner + repo`);
    }
    return {
      owner: o.owner,
      repo: o.repo,
      rev: typeof o.rev === 'string' && o.rev ? o.rev : null,
      expectOk: o.expectOk !== false, // default to expecting success
      ...(typeof o.note === 'string' ? { note: o.note } : {}),
    };
  });
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/use-cases', (_req, res) => {
  res.json(
    USE_CASES.map(({ id, label, description }) => ({ id, label, description }))
  );
});

app.get('/api/repos', (_req, res) => {
  res.json(readRepos());
});

app.put('/api/repos', (req: Request, res: Response) => {
  try {
    const repos = sanitizeRepos(req.body);
    writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
    res.json({ ok: true, count: repos.length, file: REPOS_FILE });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/run', async (req: Request, res: Response) => {
  // Server-Sent Events: the browser reads this streamed response and renders
  // each log line / result the moment it arrives.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (!process.env.FREESTYLE_API_KEY) {
      send('error', { message: 'FREESTYLE_API_KEY is not set on the server (.env).' });
      return res.end();
    }
    const body = req.body as {
      useCaseId?: string;
      repos?: unknown;
      windowSecs?: number;
      intervalSecs?: number;
      noTeardown?: boolean;
    };
    const useCase = getUseCase(body.useCaseId ?? 'git-import');
    const repos = sanitizeRepos(body.repos ?? []);
    if (!repos.length) {
      send('error', { message: 'no repos to run' });
      return res.end();
    }
    const opts = {
      windowSecs: Number(body.windowSecs) || 45,
      intervalSecs: Number(body.intervalSecs) || 3,
      noTeardown: Boolean(body.noTeardown),
      githubToken: process.env.GITHUB_TOKEN || undefined,
    };
    send('start', { useCase: useCase.id, count: repos.length, ...opts, githubToken: undefined });

    for (const spec of repos) {
      send('log', { msg: `→ ${spec.owner}/${spec.repo}${spec.rev ? `@${spec.rev}` : ''}` });
      const result = await useCase.run(spec, {
        ...opts,
        onLog: (msg) => send('log', { msg }),
      });
      send('result', result);
    }
    send('done', { ok: true });
  } catch (e) {
    send('error', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    res.end();
  }
});

// --- interactive VM console ----------------------------------------------
// A long-lived VM you can run ad-hoc commands against (e.g. inspect what an
// import resolved to). `open` boots a VM + clones once; `exec` runs commands in
// /repo; `close` tears it down. VMs carry an idle timeout as a leak backstop.
interface VmSession {
  vmId: string;
  vm: Awaited<ReturnType<typeof freestyle.vms.create>>['vm'];
  slug: string;
  rev: string | null;
}
const sessions = new Map<string, VmSession>();
let sessionSeq = 0;

app.post('/api/vm/open', async (req: Request, res: Response) => {
  try {
    if (!process.env.FREESTYLE_API_KEY) throw new Error('FREESTYLE_API_KEY is not set (.env)');
    const [spec] = sanitizeRepos([req.body]);
    if (!spec) throw new Error('no repo provided');
    const created = await freestyle.vms.create({
      name: `console-${spec.owner}-${spec.repo}-${Date.now()}`,
      persistence: { type: 'ephemeral' },
      idleTimeoutSeconds: 600, // backstop so a forgotten session is reclaimed
    });
    const clone = await created.vm.exec({
      command: cloneCommand(spec, process.env.GITHUB_TOKEN || undefined),
      timeoutMs: 120_000,
    });
    if ((clone.statusCode ?? 1) !== 0) {
      await created.vm.delete().catch(() => {});
      return res.status(400).json({
        ok: false,
        error: `clone failed (exit ${clone.statusCode})`,
        stderr: (clone.stderr ?? '').trim().slice(0, 2000),
      });
    }
    const sessionId = `vm-${++sessionSeq}-${Date.now()}`;
    const slug = `${spec.owner}/${spec.repo}`;
    sessions.set(sessionId, { vmId: created.vmId, vm: created.vm, slug, rev: spec.rev });
    res.json({ ok: true, sessionId, vmId: created.vmId, slug, rev: spec.rev });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/vm/exec', async (req: Request, res: Response) => {
  const { sessionId, command } = req.body as { sessionId?: string; command?: string };
  const s = sessionId ? sessions.get(sessionId) : undefined;
  if (!s) {
    return res.status(404).json({ ok: false, error: 'no such VM session (stopped or idled out — reopen it)' });
  }
  if (!command || !command.trim()) {
    return res.status(400).json({ ok: false, error: 'empty command' });
  }
  try {
    const t = Date.now();
    const out = await s.vm.exec({ command: `cd /repo && ${command}`, timeoutMs: 30_000 });
    res.json({
      ok: true,
      stdout: out.stdout ?? '',
      stderr: out.stderr ?? '',
      exitCode: out.statusCode ?? null,
      durationMs: Date.now() - t,
    });
  } catch (e) {
    const d = describeError(e);
    res.status(500).json({ ok: false, error: d.message, traceId: d.traceId });
  }
});

app.post('/api/vm/close', async (req: Request, res: Response) => {
  const { sessionId } = req.body as { sessionId?: string };
  const s = sessionId ? sessions.get(sessionId) : undefined;
  if (s) {
    await s.vm.delete().catch(() => {});
    sessions.delete(sessionId as string);
  }
  res.json({ ok: true });
});

// Best-effort teardown of any open VMs when the server is stopped.
process.on('SIGINT', () => {
  const open = [...sessions.values()];
  if (!open.length) process.exit(0);
  console.log(`\nTearing down ${open.length} open VM session(s)…`);
  Promise.allSettled(open.map((s) => s.vm.delete())).finally(() => process.exit(0));
});

app.listen(PORT, () => {
  console.log(`Freestyle harness UI → http://localhost:${PORT}`);
  if (!process.env.FREESTYLE_API_KEY) {
    console.log('  (warning: FREESTYLE_API_KEY not set — runs will fail until you add it to .env)');
  }
});
