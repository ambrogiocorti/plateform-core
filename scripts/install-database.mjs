import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanInstallPlan } from './clean-install-plan.mjs';

// Fresh Supabase/Postgres only. Never resets or drops a database. Secrets stay in
// the child environment and never appear in process arguments or output.
const plan = await cleanInstallPlan();
if (process.argv.includes('--check')) {
  console.log(
    JSON.stringify({
      bootstrap_version: 1,
      bootstrap_sha256: plan.bootstrapManifest.bootstrap_sha256,
      postlude_sha256: plan.bootstrapManifest.postlude_sha256,
      migrations: plan.migrations.length,
      inventory_sha256: plan.inventorySha256,
      database_accessed: false,
    }),
  );
} else {
  const conn = new URL(process.env.SUPABASE_DB_URL || 'invalid:');
  if (
    !['postgres:', 'postgresql:'].includes(conn.protocol) ||
    !conn.hostname ||
    !conn.username ||
    !conn.pathname.slice(1)
  )
    throw new Error('SUPABASE_DB_URL_REQUIRED');
  const env = { ...process.env };
  for (const key of ['SUPABASE_DB_URL', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGHOSTADDR'])
    delete env[key];
  Object.assign(env, {
    PGHOST: conn.hostname,
    PGPORT: conn.port || '5432',
    PGUSER: decodeURIComponent(conn.username),
    PGPASSWORD: decodeURIComponent(conn.password),
    PGDATABASE: decodeURIComponent(conn.pathname.slice(1)),
    PGSSLMODE:
      process.env.PLATEFORM_INSTALL_LOCAL === '1' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(conn.hostname)
        ? 'disable'
        : 'require',
    PGCONNECT_TIMEOUT: '15',
  });
  const dir = await mkdtemp(join(tmpdir(), 'plateform-clean-install-'));
  try {
    const file = join(dir, 'install.sql');
    const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
    let sql = plan.bootstrap + '\n';
    const locations = [{ line: 1, phase: 'bootstrap' }];
    sql += `create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version text primary key, name text, statements text[]
      );
      do $history$ begin
        if exists(select 1 from supabase_migrations.schema_migrations) then
          raise exception 'CLEAN_INSTALL_REQUIRES_EMPTY_MIGRATION_HISTORY';
        end if;
      end $history$;\n`;
    let line = sql.split('\n').length;
    for (const row of plan.migrations) {
      // The ledger stores the exact historical SQL, including explicit
      // transactions. No bootstrap bytes are merged into an applied migration.
      locations.push({ line, phase: row.filename });
      // Applied ledger statements may omit the final delimiter. A standalone
      // query accepts that EOF, but a psql script needs a boundary before the
      // ledger INSERT. Add transport punctuation without rewriting stored SQL.
      const migrationSql =
        row.sql +
        '\n;\n' +
        `insert into supabase_migrations.schema_migrations(version,name,statements)
        values(${sqlLiteral(row.version)},${sqlLiteral(row.name)},
          array[convert_from(decode('${Buffer.from(row.sql).toString('hex')}','hex'),'UTF8')]);\n`;
      sql += migrationSql;
      line += migrationSql.split('\n').length - 1;
    }
    locations.push({ line, phase: 'postlude' });
    sql += '\n' + plan.postlude;
    await writeFile(file, sql, { mode: 0o600 });
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.PSQL_BIN || 'psql',
        ['-X', '-w', '--quiet', '--set', 'ON_ERROR_STOP=1', '--file', file],
        { env, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.once('error', () => reject(new Error('CLEAN_INSTALL_PSQL_UNAVAILABLE')));
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else {
          const errorCode = stderr.match(/ERROR:\s+([A-Z][A-Z0-9_]{5,})/)?.[1];
          const errorLine = Number([...stderr.matchAll(/install\.sql:(\d+):/g)].at(-1)?.[1]);
          const phase = locations.findLast((location) => location.line <= errorLine)?.phase;
          // Safe location diagnostics, without SQL values or credentials.
          reject(
            new Error(
              `CLEAN_INSTALL_FAILED:${errorCode || 'PSQL_ERROR'}:${code}:${phase || 'unknown'}:${errorLine || 0}`,
            ),
          );
        }
      });
    });
    console.log(
      JSON.stringify({
        installed: true,
        migrations: plan.migrations.length,
        inventory_sha256: plan.inventorySha256,
        bootstrap_sha256: plan.bootstrapManifest.bootstrap_sha256,
        postlude_sha256: plan.bootstrapManifest.postlude_sha256,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
