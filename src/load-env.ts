/**
 * Side-effecting `.env` loader. Imported FIRST (before any module that touches
 * the `freestyle` singleton) so `FREESTYLE_API_KEY` is in `process.env` before
 * the SDK reads it. Minimal `KEY=value` parser — existing env wins, so you can
 * override on the command line (`FREESTYLE_API_KEY=… npm run repro`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadEnv(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // no .env — rely on real env (CI, exported vars)
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || line.trim().startsWith('#')) continue;
    let val = m[2] ?? '';
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

loadEnv(path.resolve(process.cwd(), '.env'));
