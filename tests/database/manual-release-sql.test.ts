import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { database, seed } from './harness';

it('applies the reviewed SQL Editor script atomically and records the exact canonical source', async () => {
  const manifest = JSON.parse(await readFile('supabase/migration-manifest.json', 'utf8'));
  const index = manifest.migrations.findIndex(
    (m: { version: string }) => m.version === '20261107152151',
  );
  expect(index).toBeGreaterThan(0);
  const db = await database(index);
  try {
    await seed(db);
    const source = await readFile(
      'supabase/migrations/20261107152151_flexible_kitchen_and_routine_settings.sql',
      'utf8',
    );
    await db.exec(
      await readFile('supabase/manual/staff_workspaces_sql_editor_20261108.sql', 'utf8'),
    );
    const history = await db.query<{ name: string; statements: string[] }>(
      'select name,statements from supabase_migrations.schema_migrations where version=$1',
      ['20261107152151'],
    );
    expect(history.rows).toEqual([
      { name: 'flexible_kitchen_and_routine_settings', statements: [source] },
    ]);
    expect(
      (
        await db.query(
          'select reservations_enabled,customer_bill_request,returns_enabled from public.venue_settings s join public.venues v on v.id=s.venue_id where v.active',
        )
      ).rows,
    ).toEqual([{ reservations_enabled: true, customer_bill_request: true, returns_enabled: true }]);
    expect(
      (
        await db.query(
          "select licensed from public.feature_flags where name='RESERVATION_MESSAGING'",
        )
      ).rows,
    ).toEqual([{ licensed: true }]);
  } finally {
    await db.close();
  }
});
