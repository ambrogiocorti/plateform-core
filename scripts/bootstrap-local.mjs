import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const cliVersion = '2.120.0';

function ensureLocalOnlyArgs(args) {
  const tokens = args.map((item) => String(item).toLowerCase());
  for (const forbidden of [
    '--linked',
    '--db-url',
    '--project-ref',
    '--password',
    'db push',
    'db reset',
  ]) {
    assert.ok(!tokens.some((token) => token.includes(forbidden)), 'REMOTE_OR_DESTRUCTIVE_FLAG');
  }
  return true;
}

export function disposableConfig(config, projectId, databasePort) {
  assert.match(projectId, /^plateformbootstrap[a-f0-9]{12}$/);
  assert.ok(Number.isInteger(databasePort) && databasePort >= 25000 && databasePort <= 49000);
  assert.match(config, /^project_id\s*=\s*"[^"]+"/m);
  assert.match(config, /\[db\]\s*\nport\s*=\s*\d+/);
  let result = config.replace(/^project_id\s*=\s*"[^"]+"/m, `project_id = "${projectId}"`);
  result = result.replace(
    /(\[db\]\s*\nport\s*=\s*)\d+/,
    (_, prefix) => prefix + databasePort,
  );
  result = result.replace(
    /(\[api\]\s*\n(?:[^\n]*\n)*?port\s*=\s*)\d+/,
    (_, prefix) => prefix + (databasePort + 1),
  );
  assert.ok(result.includes(`project_id = "${projectId}"`));
  assert.ok(result.includes(`[db]\nport = ${databasePort}`));
  return result;
}

async function run(program, args, env = process.env) {
  ensureLocalOnlyArgs(args);
  const executable = process.platform === 'win32' ? `${program}.cmd` : program;
  const child = spawn(executable, args, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  const code = await new Promise((resolveCode, reject) => {
    child.on('error', reject);
    child.on('close', resolveCode);
  });
  if (code !== 0) throw new Error(`${program.toUpperCase()}_FAILED_EXIT_${code}`);
}

async function runCapture(program, args) {
  ensureLocalOnlyArgs(args);
  const executable = process.platform === 'win32' ? `${program}.cmd` : program;
  const child = spawn(executable, args, {
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolveCode, reject) => {
    child.on('error', reject);
    child.on('close', resolveCode);
  });
  if (code !== 0) throw new Error(`${program.toUpperCase()}_FAILED_EXIT_${code}: ${stderr.slice(-900)}`);
  return stdout.trim();
}

async function verifySource() {
  const manifest = JSON.parse(await readFile('supabase/migration-manifest.json', 'utf8'));
  assert.equal(manifest.migrations.length, 482, 'CANDIDATE_MIGRATION_COUNT_CHANGED');
  const names = new Set(manifest.migrations.map((m) => m.filename));
  assert.equal(names.size, 482, 'DUPLICATE_MIGRATION_FILE');
  assert.ok(names.has('20261006100100_continuity_rehearsal_schema_recovery.sql'));
  assert.ok(names.has('20261012075300_audit_pause_legacy_compatibility.sql'));
  return manifest;
}

export async function selfTest() {
  await verifySource();
  const id = 'plateformbootstrapabcdef123456';
  const before =
    'project_id = "plateform-development"\n\n[api]\nenabled = true\nport = 54321\n\n[db]\nport = 54322\nmajor_version = 17\n';
  const after = disposableConfig(before, id, 31997);
  assert.ok(after.includes('project_id = "plateformbootstrapabcdef123456"'));
  assert.ok(after.includes('[api]\nenabled = true\nport = 31998'));
  assert.ok(after.includes('[db]\nport = 31997'));
  assert.ok(!after.includes('project_id = "plateform-development"'));
  assert.throws(() => ensureLocalOnlyArgs(['--db-url', 'postgres://unsafe']), /REMOTE_OR_DESTRUCTIVE_FLAG/);
  assert.throws(() => ensureLocalOnlyArgs(['db reset', '--linked']), /REMOTE_OR_DESTRUCTIVE_FLAG/);
  console.log('DISPOSABLE_BOOTSTRAP_SAFETY_SELF_TEST=PASSED');
}

async function bootstrap() {
  await verifySource();
  const sourceConfig = await readFile('supabase/config.toml', 'utf8');
  const projectId = `plateformbootstrap${randomBytes(6).toString('hex')}`;
  const port = randomInt(25000, 48999);
  const sandbox = await mkdtemp(join(tmpdir(), 'plateform-bootstrap-'));
  const dir = join(sandbox, 'supabase');
  const env = { ...process.env, SUPABASE_ACCESS_TOKEN: '' };
  let started = false;
  try {
    await mkdir(dir);
    await cp('supabase/migrations', join(dir, 'migrations'), { recursive: true });
    await writeFile(join(dir, 'config.toml'), disposableConfig(sourceConfig, projectId, port));
    for (const extra of ['roles.sql']) {
      try {
        await copyFile(join('supabase', extra), join(dir, extra));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    console.log(`DISPOSABLE_PROJECT=${projectId} LOCAL_PORT=${port}`);
    console.log('Il comando seguente opera soltanto su un container Docker locale temporaneo.');
    await runCapture('docker', ['info', '--format', '{{.ServerVersion}}']);
    const cliArgs = ['--yes', `supabase@${cliVersion}`, '--workdir', sandbox];
    await run('npx', [...cliArgs, 'db', 'start'], env);
    started = true;
    const query = [
      'select',
      "(select count(*) from supabase_migrations.schema_migrations)::text",
      "|| '|' || (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace",
      "where n.nspname='private' and c.relname like 'continuity_rehearsal_%'",
      "and c.relkind in ('r','p'))::text",
      "|| '|' || (to_regclass('auth.users') is not null)::text",
      "|| '|' || (to_regclass('storage.objects') is not null)::text;",
    ].join(' ');
    const result = await runCapture('docker', [
      'exec', `supabase_db_${projectId}`,
      'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
      '-c', query,
    ]);
    console.log(`LOCAL_BOOTSTRAP_CATALOG=${result}`);
    assert.equal(result, '482|7|true|true', 'POSTGRESQL_BOOTSTRAP_INCOMPLETE');
    console.log('PLATEFORM_LOCAL_POSTGRES_BOOTSTRAP=PASS');
  } finally {
    if (started) {
      try {
        await run('npx', [
          '--yes', `supabase@${cliVersion}`, '--workdir', sandbox,
          'stop', '--project-id', projectId, '--no-backup',
        ], env);
      } catch (error) {
        console.error('TEMPORARY_CONTAINER_CLEANUP_FAILED: remove only ' + projectId);
        console.error(String(error));
      }
    }
    await rm(sandbox, { recursive: true, force: true });
  }
}

if (process.argv[1] && basename(resolve(process.argv[1])) === 'bootstrap-local.mjs') {
  const option = process.argv[2] ?? '--self-test';
  if (option === '--self-test') await selfTest();
  else if (option === '--run') await bootstrap();
  else throw new Error('USE_--self-test_OR_--run');
}
