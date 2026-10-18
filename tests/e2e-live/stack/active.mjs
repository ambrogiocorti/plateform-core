// Resolves the stack the suite was started on (tests/e2e-live/.stack/env.json, written by `up`).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(import.meta.dirname, '../.stack/env.json');
export const active = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : { mode: 'native', supabaseUrl: 'http://127.0.0.1:54321' };

/** Fresh copy of the seeded database before each test. */
export async function reset() {
  const stack = await import(active.mode === 'supabase' ? './supabase-stack.mjs' : './stack.mjs');
  await stack.reset();
}
