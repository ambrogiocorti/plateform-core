import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpDatabase } from '../tools/backup-worker/dump.mjs';

const temp = await mkdtemp(join(tmpdir(), 'plateform-snapshot-consistency-'));
const fakeSupabase = join(temp, 'supabase');
const fakePsql = join(temp, 'psql');
const counterFile = join(temp, 'counter.txt');
const hashA = 'ab'.repeat(32);
const hashB = 'cd'.repeat(32);
const privateHashA = 'ef'.repeat(32);
const privateHashB = '12'.repeat(32);
const versionA = '20261004160452';
const versionB = '20261004160453';

async function runScenario(name, mode, expectedError = null) {
  await writeFile(counterFile, '0');
  process.env.FAKE_MODE = mode;
  process.env.FAKE_COUNTER = counterFile;
  const directory = join(temp, name);
  await mkdir(directory, { mode: 0o700 });
  let errorCode = '';
  try {
    const result = await dumpDatabase(
      {
        supabaseCli: fakeSupabase,
        psql: fakePsql,
        databaseUrl: 'postgresql://postgres.testref:pw@localhost:5432/postgres',
      },
      directory,
    );
    if (expectedError) throw new Error(`EXPECTED_${expectedError}`);
    if (
      result.authUserCount !== 2 ||
      result.migrationCount !== 103 ||
      result.migrationLatestVersion !== versionA ||
      result.migrationAggregateSha256 !== hashA ||
      Number(result.privateState?.row_count) !== 42 ||
      result.privateState?.aggregate_sha256 !== privateHashA
    )
      throw new Error('STABLE_RESULT_INVALID');
  } catch (error) {
    errorCode = error instanceof Error ? error.message : '';
    if (!expectedError) throw error;
  }
  if (expectedError && errorCode !== expectedError) throw new Error(`${name}:${errorCode}`);
}

try {
  await writeFile(
    fakeSupabase,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nconst args=process.argv.slice(2); const i=args.indexOf('-f'); if(i<0) process.exit(2); const out=args[i+1];\nconst term=String.fromCharCode(92)+'.';\nlet body='-- '+out+'\\n'+('x'.repeat(96))+'\\n';\nif(out.endsWith('data.sql')&&!out.endsWith('history_data.sql')) body='COPY auth.users (id,email) FROM stdin;\\n1\\ta@example.test\\n2\\tb@example.test\\n'+term+'\\n'+('d'.repeat(96))+'\\n';\nif(out.endsWith('history_schema.sql')) body='create schema if not exists supabase_migrations;\\n'+('s'.repeat(96))+'\\n';\nif(out.endsWith('history_data.sql')) body='COPY supabase_migrations.schema_migrations (version,name,statements) FROM stdin;\\n'+('m'.repeat(96))+'\\n'+term+'\\n';\nwriteFileSync(out,body,{mode:0o600});\n`,
    { mode: 0o700 },
  );
  await chmod(fakeSupabase, 0o700);

  await writeFile(
    fakePsql,
    `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst path=process.env.FAKE_COUNTER; let n=Number(readFileSync(path,'utf8')||'0'); n+=1; writeFileSync(path,String(n));\nconst mode=process.env.FAKE_MODE||'stable'; let auth=2,hash='${hashA}',version='${versionA}',privateHash='${privateHashA}',privateRows=42;\nif(mode==='auth-change'&&n>=2) auth=3;\nif(mode==='migration-change'&&n>=2) { hash='${hashB}'; version='${versionB}'; }\nif(mode==='private-change'&&n>=2) { privateHash='${privateHashB}'; privateRows=43; }\nif(mode==='auth-dump-mismatch') auth=3;\nprocess.stdout.write(JSON.stringify({auth_user_count:auth,migration_count:103,migration_latest_version:version,migration_aggregate_sha256:hash,private_state:{table_count:11,row_count:privateRows,aggregate_sha256:privateHash}})+'\\n');\n`,
    { mode: 0o700 },
  );
  await chmod(fakePsql, 0o700);

  await runScenario('stable', 'stable');
  await runScenario('auth-change', 'auth-change', 'DATABASE_SNAPSHOT_CHANGED_DURING_BACKUP');
  await runScenario(
    'migration-change',
    'migration-change',
    'DATABASE_SNAPSHOT_CHANGED_DURING_BACKUP',
  );
  await runScenario('private-change', 'private-change', 'DATABASE_SNAPSHOT_CHANGED_DURING_BACKUP');
  await runScenario('auth-dump-mismatch', 'auth-dump-mismatch', 'AUTH_DUMP_COUNT_MISMATCH');

  console.log('STEP12_DATABASE_SNAPSHOT_STABILITY=PASSED');
  console.log('STEP12_AUTH_CHANGE_DURING_BACKUP_FAIL_CLOSED=PASSED');
  console.log('STEP12_MIGRATION_CHANGE_DURING_BACKUP_FAIL_CLOSED=PASSED');
  console.log('STEP12_PRIVATE_STATE_CHANGE_DURING_BACKUP_FAIL_CLOSED=PASSED');
  console.log('STEP12_AUTH_DUMP_COUNT_FAIL_CLOSED=PASSED');
} finally {
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_COUNTER;
  await rm(temp, { recursive: true, force: true });
}
