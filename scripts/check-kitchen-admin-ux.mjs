import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('src/pages/kitchen.ts');
const css = read('styles/staff.css');
const migration = read('supabase/migrations/20261005170110_kitchen_admin_operational_overview.sql');

const checks = [
  [
    'overview RPC usata solo per Kitchen Admin',
    source.includes("context.profile.role === 'KITCHEN_ADMIN'") &&
      source.includes("'get_kitchen_admin_overview'"),
  ],
  [
    'riepilogo operativo completo',
    ['STEP ATTIVI', 'RICEVUTI', 'IN PREPARAZIONE', 'PRONTI', 'RITARDO >10′', 'CRITICI >20′'].every(
      (x) => source.includes(x),
    ),
  ],
  [
    'carico per stazione',
    source.includes('Carico per stazione') && source.includes('kitchen-admin-station-counts'),
  ],
  [
    'ritardi 10/20 evidenziati',
    source.includes('summary.critical') &&
      source.includes('summary.delayed') &&
      css.includes('.kitchen-admin-kpi.is-critical'),
  ],
  [
    'resi recenti visibili',
    source.includes('Piatti tornati indietro') && source.includes('data.returns'),
  ],
  [
    'KDS operativa preservata',
    source.includes("'get_kitchen_board'") &&
      source.includes("'transition_order_item'") &&
      source.includes("'mark_step_ready'"),
  ],
  [
    'workflow reso REMAKE/CANCEL_REQUEST preservato',
    source.includes("['REMAKE', 'CANCEL_REQUEST']") && source.includes("'return_order_item'"),
  ],
  [
    'overview non scompare con KDS vuota',
    source.includes('if (!adminOverview) return served') &&
      source.includes(
        "return el('div', { class: 'stack' }, kitchenAdminPanel(adminOverview, board), board, served)",
      ),
  ],
  [
    'RPC server autorizza solo Admin/Kitchen Admin',
    migration.includes("array['ADMIN','KITCHEN_ADMIN']::public.user_role[]") &&
      migration.includes('private.authorize'),
  ],
  [
    'layout coordinamento responsive',
    css.includes('.kitchen-admin-summary') &&
      css.includes('@media (max-width: 1100px)') &&
      css.includes('@media (max-width: 700px)'),
  ],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`KITCHEN_ADMIN_UX_GATE=FAILED ${checks.length - failed}/${checks.length}`);
  process.exit(1);
}
console.log(`KITCHEN_ADMIN_UX_GATE=PASSED ${checks.length}/${checks.length}`);
