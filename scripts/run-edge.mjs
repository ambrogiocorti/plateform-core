import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (!['check', 'test'].includes(mode))
  throw new Error('Usage: node scripts/run-edge.mjs check|test');
const paths =
  mode === 'check'
    ? readdirSync('supabase/functions', { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
        .map((entry) => `supabase/functions/${entry.name}/index.ts`)
    : ['supabase/functions/_tests'];
const result = spawnSync(
  process.execPath,
  [
    resolve('node_modules/deno/bin.cjs'),
    mode,
    '--node-modules-dir=manual',
    '--config',
    'supabase/functions/deno.json',
    ...(mode === 'test' ? ['--allow-env'] : []),
    ...paths,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, DENO_DIR: resolve('.local/deno') },
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
