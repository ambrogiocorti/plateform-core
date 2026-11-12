import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpDatabase } from '../tools/backup-worker/dump.mjs';
import { restoreDatabase, verifyMigrationHistory } from '../tools/restore-test-worker/database.mjs';

const temp = await mkdtemp(join(tmpdir(), 'plateform-migration-history-'));
const log = join(temp, 'commands.log');
const fakeSupabase = join(temp, 'supabase');
const fakePsql = join(temp, 'psql');
const expectedHash = 'ab'.repeat(32);
const expectedVersion = '20261004155039';
try {
  await writeFile(
    fakeSupabase,
    `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from 'node:fs';\nconst args=process.argv.slice(2); appendFileSync(process.env.FAKE_LOG,'supabase '+JSON.stringify(args)+'\\n');\nconst i=args.indexOf('-f'); if(i<0) process.exit(2); const out=args[i+1];\nconst terminator=String.fromCharCode(92)+'.';\nlet body='-- '+out+'\\n'+('x'.repeat(80))+'\\n';\nif(out.endsWith('data.sql')&&!out.endsWith('history_data.sql')) body='COPY auth.users (id,email) FROM stdin;\\n1\\ta@example.test\\n2\\tb@example.test\\n'+terminator+'\\n'+('d'.repeat(80))+'\\n';\nif(out.endsWith('history_schema.sql')) body='create schema if not exists supabase_migrations;\\n'+('s'.repeat(80))+'\\n';\nif(out.endsWith('history_data.sql')) body='COPY supabase_migrations.schema_migrations (version,name,statements) FROM stdin;\\n'+('m'.repeat(80))+'\\n'+terminator+'\\n';\nwriteFileSync(out,body,{mode:0o600});\n`,
    { mode: 0o700 },
  );
  await chmod(fakeSupabase, 0o700);
  await writeFile(
    fakePsql,
    `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nconst args=process.argv.slice(2); appendFileSync(process.env.FAKE_LOG,'psql '+JSON.stringify(args)+'\\n');\nconst ci=args.indexOf('--command'); const cmd=ci>=0?args[ci+1]:'';\nif(cmd.includes('auth_user_count')) process.stdout.write(JSON.stringify({auth_user_count:2,migration_count:98,migration_latest_version:'${expectedVersion}',migration_aggregate_sha256:'${expectedHash}',private_state:{table_count:11,row_count:42,aggregate_sha256:'${expectedHash}'}})+'\\n');\nelse if(cmd.includes('supabase_migrations.schema_migrations')) process.stdout.write(JSON.stringify({count:98,latest_version:'${expectedVersion}',aggregate_sha256:'${expectedHash}'})+'\\n');\n`,
    { mode: 0o700 },
  );
  await chmod(fakePsql, 0o700);
  process.env.FAKE_LOG = log;

  const directory = join(temp, 'backup');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { mode: 0o700 }));
  const config = {
    supabaseCli: fakeSupabase,
    psql: fakePsql,
    databaseUrl: 'postgresql://postgres.testref:pw@localhost:5432/postgres',
  };
  const result = await dumpDatabase(config, directory);
  if (result.authUserCount !== 2) throw new Error(`AUTH_COUNT:${result.authUserCount}`);
  if (
    result.migrationCount !== 98 ||
    result.migrationLatestVersion !== expectedVersion ||
    result.migrationAggregateSha256 !== expectedHash
  )
    throw new Error('MIGRATION_STATE');
  const commandLog = await readFile(log, 'utf8');
  if (
    !commandLog.includes('history_schema.sql') ||
    !commandLog.includes('history_data.sql') ||
    !commandLog.includes('supabase_migrations')
  )
    throw new Error('MIGRATION_DUMP_COMMANDS');

  await restoreDatabase(
    {
      psql: fakePsql,
      targetDatabaseUrl: 'postgresql://postgres.target:pw@localhost:5432/postgres',
    },
    {
      roles: result.roles,
      schema: result.schema,
      data: result.data,
      historySchema: result.historySchema,
      historyData: result.historyData,
    },
  );
  const afterRestore = await readFile(log, 'utf8');
  const psqlLines = afterRestore.split('\n').filter((line) => line.startsWith('psql '));
  if (
    !psqlLines.some(
      (line) => line.includes('history_schema.sql') && line.includes('history_data.sql'),
    )
  )
    throw new Error('MIGRATION_RESTORE_SEQUENCE');

  const verified = await verifyMigrationHistory(
    {
      psql: fakePsql,
      targetDatabaseUrl: 'postgresql://postgres.target:pw@localhost:5432/postgres',
    },
    {
      count: 98,
      latest_version: expectedVersion,
      aggregate_sha256: expectedHash,
    },
  );
  if (
    verified.migrations !== true ||
    verified.migration_count !== 98 ||
    verified.migration_latest_version !== expectedVersion ||
    verified.migration_hash !== expectedHash
  )
    throw new Error('MIGRATION_VERIFY');
  const mismatch = await verifyMigrationHistory(
    {
      psql: fakePsql,
      targetDatabaseUrl: 'postgresql://postgres.target:pw@localhost:5432/postgres',
    },
    {
      count: 99,
      latest_version: expectedVersion,
      aggregate_sha256: expectedHash,
    },
  );
  if (mismatch.migrations !== false) throw new Error('MIGRATION_MISMATCH_NOT_DETECTED');
  const versionMismatch = await verifyMigrationHistory(
    {
      psql: fakePsql,
      targetDatabaseUrl: 'postgresql://postgres.target:pw@localhost:5432/postgres',
    },
    {
      count: 98,
      latest_version: '20261004155038',
      aggregate_sha256: expectedHash,
    },
  );
  if (versionMismatch.migrations !== false)
    throw new Error('MIGRATION_VERSION_MISMATCH_NOT_DETECTED');

  console.log('STEP12_MIGRATION_HISTORY_DUMP=PASSED');
  console.log('STEP12_MIGRATION_HISTORY_RESTORE=PASSED');
  console.log('STEP12_MIGRATION_HISTORY_VERIFY=PASSED');
  console.log('STEP12_MIGRATION_HISTORY_LATEST_VERSION=PASSED');
  console.log('STEP12_MIGRATION_HISTORY_MISMATCH_FAIL_CLOSED=PASSED');
} finally {
  delete process.env.FAKE_LOG;
  await rm(temp, { recursive: true, force: true });
}
