import fs from 'node:fs';

const kitchen = fs.readFileSync(new URL('../src/pages/kitchen.ts', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles/staff.css', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL(
    '../supabase/migrations/20261005163939_kitchen_board_allergen_snapshot.sql',
    import.meta.url,
  ),
  'utf8',
);

const checks = [
  ['allergen schema', kitchen.includes('allergens: z.array(z.string())')],
  ['allergen UI', kitchen.includes('ALLERGENI:')],
  ['elapsed timer', kitchen.includes('elapsedLabel') && kitchen.includes('kds-timer')],
  ['pass ready banner', kitchen.includes('PRONTO PER IL SERVIZIO')],
  ['prepare action', kitchen.includes('RICEVUTO → PREPARA') && kitchen.includes('SEGNA PRONTO')],
  ['historical allergen snapshot', migration.includes("'allergens',coalesce(i.allergen_snapshot")],
  ['rpc authorization preserved', migration.includes('private.authorize(')],
  [
    'rpc grants constrained',
    migration.includes('revoke all on function public.get_kitchen_board(uuid) from public, anon'),
  ],
  ['large operational controls', css.includes('.kds-ticket') && css.includes('min-height: 58px')],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
