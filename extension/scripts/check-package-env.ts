/**
 * `pnpm package` refuses to build a zip that can't back up: the trial build must know the
 * hosted Supabase project. Reads the same places WXT does for a production build
 * (the environment, then .env.production.local, .env.production, .env.local, .env).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const NAMES = ['WXT_SUPABASE_URL', 'WXT_SUPABASE_PUBLISHABLE_KEY'];
const root = path.resolve(import.meta.dirname, '..');

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1]) values[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

const files = ['.env', '.env.local', '.env.production', '.env.production.local'];
// Later files win, as in Vite.
const merged = files.reduce<Record<string, string>>(
  (all, f) => ({ ...all, ...readEnvFile(path.join(root, f)) }),
  {},
);
const value = (name: string): string => process.env[name] || merged[name] || '';

const missing = NAMES.filter((name) => !value(name));
if (missing.length) {
  console.error(
    `Can't package: ${missing.join(' and ')} not set. Put the hosted project's URL and ` +
      'publishable key in extension/.env (see .env.example); without them the build ' +
      "can't back up or search by description.",
  );
  process.exit(1);
}
const url = value('WXT_SUPABASE_URL');
if (/127\.0\.0\.1|localhost/.test(url)) {
  console.error(`Can't package: WXT_SUPABASE_URL points at this computer (${url}).`);
  process.exit(1);
}
console.log(`Packaging for ${url}`);
