
insert into private.release_test_catalog(key,category,required,description) values
  ('RECIPE_UNIT_CONVERSION','REGRESSION',true,'Recipe units convert deterministically and incompatible dimensions fail closed.'),
  ('INGREDIENT_COST_IDEMPOTENCY_AUDIT','REGRESSION',true,'Ingredient cost writes are ADMIN-authorized, idempotent and audited with economic fields.'),
  ('FOOD_COST_CALCULATION','REGRESSION',true,'Server-side food cost selects venue cost over chain fallback and computes theoretical margin deterministically.'),
  ('FOOD_COST_SNAPSHOT_HISTORY','REGRESSION',true,'Food-cost snapshots preserve historical values across cost changes and are immutable.')
on conflict(key) do nothing;
