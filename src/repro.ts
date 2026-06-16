/**
 * CLI entry — reproduce Freestyle Git server-side `source` import failures.
 *
 *   npm run repro                                  # the default investigation set
 *   npm run repro -- --repo anomalyco/opencode@dev # one repo (optional @rev)
 *   npm run repro -- --repo a/b --repo c/d         # several
 *   npm run repro -- --window 60 --interval 3      # tune the readiness poll
 *   npm run repro -- --no-teardown                 # leave the Freestyle repos up
 *   npm run repro -- --json results/run.json       # also write structured output
 *
 * Reads FREESTYLE_API_KEY (required) and GITHUB_TOKEN (optional for public repos)
 * from `.env`. Prints a per-repo evidence table — create time, populate result /
 * INTERNAL_ERROR, fresh traceId — then tears down everything it created.
 */
import './load-env.js'; // MUST be first — populates env before the SDK loads.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_REPOS, parseRepoArg, type RepoSpec } from './repos.js';
import { probeRepo, type ProbeResult } from './probe.js';

interface Args {
  repos: RepoSpec[];
  windowSecs: number;
  intervalSecs: number;
  noTeardown: boolean;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const repos: RepoSpec[] = [];
  let windowSecs = 45;
  let intervalSecs = 3;
  let noTeardown = false;
  let json: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--repo':
        repos.push(parseRepoArg(argv[++i] ?? ''));
        break;
      case '--window':
        windowSecs = Number(argv[++i]);
        break;
      case '--interval':
        intervalSecs = Number(argv[++i]);
        break;
      case '--no-teardown':
        noTeardown = true;
        break;
      case '--json':
        json = argv[++i] ?? null;
        break;
      default:
        if (a?.startsWith('--')) throw new Error(`unknown flag ${a}`);
    }
  }
  return {
    repos: repos.length ? repos : DEFAULT_REPOS,
    windowSecs,
    intervalSecs,
    noTeardown,
    json,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function printTable(results: ProbeResult[]): void {
  const cols = [
    ['repo', 28],
    ['rev', 8],
    ['create', 8],
    ['result', 16],
    ['detail', 30],
  ] as const;
  const header = cols.map(([h, w]) => pad(h, w)).join('  ');
  console.log('\n' + header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    let result: string;
    let detail: string;
    if (r.fatal) {
      result = 'CREATE FAILED';
      detail = r.traceId ? `trace ${r.traceId}` : r.errorCode ?? '';
    } else if (r.populated) {
      result = 'populated';
      detail = `${r.populateMs}ms / ${r.attempts} polls`;
    } else if (r.errorCode) {
      // A real server-side error (e.g. INTERNAL_ERROR) — the bug.
      result = r.errorCode;
      detail = r.traceId ? `trace ${r.traceId}` : `${r.attempts} polls`;
    } else {
      // No Freestyle error code → a client-side/transport failure (e.g. a
      // `fetch failed` timeout on a very slow import). NOT the server bug —
      // labeled distinctly so it isn't conflated with INTERNAL_ERROR.
      result = 'client error';
      detail = `${r.errorMessage ?? 'unknown'}${r.errorCause ? ` (${r.errorCause})` : ''}`.slice(0, 30);
    }
    const flag = r.populated === (r.expect === 'populates') ? ' ' : '!';
    console.log(
      [
        pad(`${flag} ${r.slug}`, 28),
        pad(r.rev ?? '(def)', 8),
        pad(r.createMs != null ? `${r.createMs}ms` : '—', 8),
        pad(result, 16),
        pad(detail, 30),
      ].join('  ')
    );
  }
  console.log(
    '\n(! = observed outcome differs from the expectation in repos.ts)\n'
  );
}

async function main(): Promise<void> {
  if (!process.env.FREESTYLE_API_KEY) {
    console.error(
      'FREESTYLE_API_KEY is not set. Copy .env.example to .env and fill it in.'
    );
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const githubToken = process.env.GITHUB_TOKEN || undefined;

  console.log(
    `Freestyle Git import repro — ${args.repos.length} repo(s), ` +
      `window ${args.windowSecs}s / interval ${args.intervalSecs}s` +
      (githubToken ? '' : ' (no GITHUB_TOKEN — anonymous, public repos only)')
  );

  const results: ProbeResult[] = [];
  for (const spec of args.repos) {
    // Sequential: keeps timings clean and load on Freestyle modest.
    const r = await probeRepo(spec, {
      windowSecs: args.windowSecs,
      intervalSecs: args.intervalSecs,
      noTeardown: args.noTeardown,
      githubToken,
      onLog: (m) => console.log('  ' + m),
    });
    results.push(r);
  }

  printTable(results);

  if (args.json) {
    const out = {
      capturedAt: new Date().toISOString(),
      window: { seconds: args.windowSecs, intervalSeconds: args.intervalSecs },
      sdk: 'freestyle@0.1.63',
      results,
    };
    mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    writeFileSync(path.resolve(args.json), JSON.stringify(out, null, 2));
    console.log(`Wrote ${args.json}`);
  }

  // Exit non-zero if any repo's outcome contradicts its expectation, so this is
  // usable as a regression check once Freestyle ships a fix.
  const mismatch = results.some(
    (r) => !r.fatal && r.populated !== (r.expect === 'populates')
  );
  process.exit(mismatch ? 1 : 0);
}

main().catch((e) => {
  // Usage/config errors should read cleanly; only dump a stack for the
  // genuinely unexpected (set REPRO_DEBUG=1 to always see it).
  if (process.env.REPRO_DEBUG) console.error(e);
  else console.error('Error:', e instanceof Error ? e.message : String(e));
  process.exit(2);
});
