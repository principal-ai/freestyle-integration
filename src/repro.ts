/**
 * CLI entry — run a use case over a repo list and print an evidence table.
 *
 *   npm run repro                                    # git-import, default repo set
 *   npm run repro -- --use-case vm-bash              # the VM bash-exec probe
 *   npm run repro -- --repo anomalyco/opencode@dev   # one repo (optional @rev)
 *   npm run repro -- --repo a/b --repo c/d           # several
 *   npm run repro -- --window 60 --interval 3        # tune the readiness wait
 *   npm run repro -- --no-teardown                   # leave Freestyle resources up
 *   npm run repro -- --json results/run.json         # also write structured output
 *
 * Reads FREESTYLE_API_KEY (required) and GITHUB_TOKEN (optional for public repos)
 * from `.env`. Exits non-zero if any repo's observed outcome contradicts its
 * expectation, so it doubles as a regression guard.
 */
import './load-env.js'; // MUST be first — populates env before the SDK loads.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_REPOS, parseRepoArg, type RepoSpec } from './repos.js';
import { getUseCase, type RunResult } from './use-cases.js';

interface Args {
  useCaseId: string;
  repos: RepoSpec[];
  windowSecs: number;
  intervalSecs: number;
  noTeardown: boolean;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const repos: RepoSpec[] = [];
  let useCaseId = 'git-import';
  let windowSecs = 45;
  let intervalSecs = 3;
  let noTeardown = false;
  let json: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--use-case':
        useCaseId = argv[++i] ?? '';
        break;
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
    useCaseId,
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

function printTable(results: RunResult[]): void {
  const cols = [
    ['repo', 28],
    ['rev', 8],
    ['took', 8],
    ['status', 16],
    ['detail', 32],
  ] as const;
  const header = cols.map(([h, w]) => pad(h, w)).join('  ');
  console.log('\n' + header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    // `!` flags an observed outcome that contradicts the expectation.
    const flag = r.ok === r.expectOk ? ' ' : '!';
    console.log(
      [
        pad(`${flag} ${r.slug}`, 28),
        pad(r.rev ?? '(def)', 8),
        pad(r.durationMs != null ? `${r.durationMs}ms` : '—', 8),
        pad(r.status, 16),
        pad(r.detail, 32),
      ].join('  ')
    );
  }
  console.log('\n(! = observed outcome differs from the expectation in the spec)\n');
}

async function main(): Promise<void> {
  if (!process.env.FREESTYLE_API_KEY) {
    console.error(
      'FREESTYLE_API_KEY is not set. Copy .env.example to .env and fill it in.'
    );
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const useCase = getUseCase(args.useCaseId);
  const githubToken = process.env.GITHUB_TOKEN || undefined;

  console.log(
    `Freestyle harness — use case "${useCase.id}" (${useCase.label}), ` +
      `${args.repos.length} repo(s), window ${args.windowSecs}s / interval ${args.intervalSecs}s` +
      (githubToken ? '' : ' (no GITHUB_TOKEN — anonymous, public repos only)')
  );

  const results: RunResult[] = [];
  for (const spec of args.repos) {
    // Sequential: keeps timings clean and load on Freestyle modest.
    const r = await useCase.run(spec, {
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
      useCase: useCase.id,
      window: { seconds: args.windowSecs, intervalSeconds: args.intervalSecs },
      sdk: 'freestyle@0.1.63',
      results,
    };
    mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    writeFileSync(path.resolve(args.json), JSON.stringify(out, null, 2));
    console.log(`Wrote ${args.json}`);
  }

  // Exit non-zero if any repo's outcome contradicts its expectation, so this is
  // usable as a regression check.
  const mismatch = results.some((r) => r.ok !== r.expectOk);
  process.exit(mismatch ? 1 : 0);
}

main().catch((e) => {
  // Usage/config errors should read cleanly; only dump a stack for the
  // genuinely unexpected (set REPRO_DEBUG=1 to always see it).
  if (process.env.REPRO_DEBUG) console.error(e);
  else console.error('Error:', e instanceof Error ? e.message : String(e));
  process.exit(2);
});
