import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cleanInstallPlan } from './clean-install-plan.mjs';

const plan = await cleanInstallPlan();
const hash = (text) => createHash('sha256').update(text).digest('hex');
const dir = '.local/hosted-installer';
await mkdir(dir, { recursive: true, mode: 0o700 });
const barrier = await readFile('supabase/clean-install/disarm-cron.sql', 'utf8');
const payload = {
  bootstrap: plan.bootstrap,
  bootstrap_sha256: hash(plan.bootstrap),
  postlude: plan.postlude,
  postlude_sha256: hash(plan.postlude),
  barrier,
  barrier_sha256: hash(barrier),
  migrations: plan.migrations,
};
const created = Date.now();
const token = randomBytes(32).toString('hex');
const config = {
  project_ref: 'kghactswtabakkkbojmo',
  source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  created_at_ms: created,
  expires_at_ms: created + 60 * 60 * 1000,
  token_sha256: hash(token),
  payload_sha256: hash(JSON.stringify(payload)),
  inventory_sha256: plan.inventorySha256,
};
await writeFile(`${dir}/payload.json`, JSON.stringify(payload), { mode: 0o600 });
await writeFile(`${dir}/deployment.json`, JSON.stringify(config), { mode: 0o600 });
await writeFile(`${dir}/token`, token, { mode: 0o600 });
for (const filename of ['index.ts', 'handler.mjs'])
  await copyFile(`scripts/hosted-installer/${filename}`, `${dir}/${filename}`);
await writeFile(
  `${dir}/deno.json`,
  JSON.stringify({ nodeModulesDir: 'none', compilerOptions: { strict: true } }),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    ...config,
    token_sha256: config.token_sha256,
    secret_written: true,
    files: ['index.ts', 'handler.mjs', 'payload.json', 'deployment.json', 'deno.json'],
  }),
);
