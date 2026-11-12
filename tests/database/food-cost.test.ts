import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed } from './harness';

const category = 'f1000000-0000-4000-8000-000000000001';
const dish = 'f1000000-0000-4000-8000-000000000002';
const ingredient = 'f1000000-0000-4000-8000-000000000003';
const quoteKey = 'f1000000-0000-4000-8000-000000000004';
const compositionKey = 'f1000000-0000-4000-8000-000000000005';
const snapshotKey = 'f1000000-0000-4000-8000-000000000006';

describe('food cost commercial RPC contract', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.exec(`
      update public.staff_profiles set scope='CHAIN' where id='${ids.admin}';
      update public.feature_flags set licensed=true where name='FOOD_COST';
      insert into public.venue_features(venue_id,name,enabled)
      values('${ids.venue}','FOOD_COST',true)
      on conflict(venue_id,name) do update set enabled=true;
      insert into public.categories(id,name) values('${category}','Pasta');
      insert into public.ingredients(id,name) values('${ingredient}','Farina');
      insert into public.dishes(id,category_id,name,price_cents)
      values('${dish}','${category}','Piatto',1000);
    `);
  });
  afterAll(async () => {
    await db?.close();
  });

  it('enforces venue authorization instead of trusting the browser license flag', async () => {
    await identity(db, ids.host);
    await expect(
      db.query('select public.get_dish_food_cost($1,$2)', [dish, ids.venue]),
    ).rejects.toThrow(/FORBIDDEN/);
    await db.exec('reset role');
  });

  it('saves ingredient history, calculates exact margins and records an idempotent snapshot', async () => {
    await identity(db, ids.admin);
    const composition = [{ ingredient_id: ingredient, removable: false, quantity: 250, unit: 'G' }];
    await db.query('select public.save_dish_composition($1,$2,$3::jsonb,$4::uuid[],$5::jsonb,$6)', [
      dish,
      1,
      JSON.stringify(composition),
      [],
      '[]',
      compositionKey,
    ]);
    const instant = new Date(Date.now() - 60_000).toISOString();
    const quote = (
      await db.query<{ result: { id: string } }>(
        'select public.set_ingredient_cost($1,$2,$3,$4,$5,$6,$7) result',
        [ingredient, ids.venue, 10_000_000, 'KG', instant, 'Test supplier', quoteKey],
      )
    ).rows[0]?.result;
    expect(quote?.id).toBeTruthy();
    const again = (
      await db.query<{ result: { id: string } }>(
        'select public.set_ingredient_cost($1,$2,$3,$4,$5,$6,$7) result',
        [ingredient, ids.venue, 10_000_000, 'KG', instant, 'Test supplier', quoteKey],
      )
    ).rows[0]?.result;
    expect(again?.id).toBe(quote?.id);
    const row = (
      await db.query<{
        result: {
          recipe_complete: boolean;
          cost_complete: boolean;
          food_cost_cents: number;
          food_cost_percentage: number;
          gross_margin_cents: number;
        };
      }>('select public.get_dish_food_cost($1,$2) result', [dish, ids.venue])
    ).rows[0]?.result;
    expect(row).toMatchObject({
      recipe_complete: true,
      cost_complete: true,
      food_cost_cents: 250,
      food_cost_percentage: 25,
      gross_margin_cents: 750,
    });
    const first = (
      await db.query<{ result: { id: string } }>(
        'select public.snapshot_dish_food_cost($1,$2,$3) result',
        [dish, ids.venue, snapshotKey],
      )
    ).rows[0]?.result;
    expect(first?.id).toBeTruthy();
    const replay = (
      await db.query<{ result: { id: string } }>(
        'select public.snapshot_dish_food_cost($1,$2,$3) result',
        [dish, ids.venue, snapshotKey],
      )
    ).rows[0]?.result;
    expect(replay?.id).toBe(first?.id);
    expect(
      (
        await db.query<{ count: number }>(
          'select count(*)::int count from public.dish_food_cost_snapshots where dish_id=$1',
          [dish],
        )
      ).rows[0]?.count,
    ).toBe(1);
    await db.exec('reset role');
  });
});
