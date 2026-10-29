import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('apps/staff/main.ts');
const page = read('src/pages/admin-operations.ts');
const css = read('styles/staff.css');
const migration = read('supabase/migrations/20261005170559_admin_operational_overview.sql');

const checks = [
  [
    'operazioni è landing Admin',
    app.indexOf("path: '/operazioni'") < app.indexOf("path: '/accoglienza'") &&
      app.includes("roles: ['ADMIN'], section: 'OPERATIVITÀ'"),
  ],
  [
    'route operazioni usa pagina dedicata',
    app.includes("pageLink.path === '/operazioni'") && app.includes('adminOperationsPage(context)'),
  ],
  [
    'sidebar separa operatività e configurazione',
    app.includes("['OPERATIVITÀ', 'CONFIGURAZIONE'] as const") && css.includes('.sidebar-section'),
  ],
  [
    'overview usa una RPC authoritative',
    page.includes("'get_admin_operational_overview'") && page.includes('adminOverviewSchema'),
  ],
  [
    'priorità immediate presenti',
    page.includes("class: 'ops-attention-card'") &&
      page.includes('priorities.filter((item) => item.value > 0)') &&
      page.includes('severity'),
  ],
  [
    'sala nel colpo d’occhio',
    page.includes("'Sala'") &&
      page.includes('data.tables.occupied') &&
      page.includes('data.tables.waiting_bill'),
  ],
  [
    'accoglienza nel colpo d’occhio',
    page.includes("'Accoglienza'") &&
      page.includes('data.reservations.requested') &&
      page.includes('data.reservations.arrived'),
  ],
  [
    'cucina nel colpo d’occhio',
    page.includes("'Cucina'") &&
      page.includes('data.kitchen.critical') &&
      page.includes("context.navigate('/cucina')"),
  ],
  [
    'cassa nel colpo d’occhio',
    page.includes("'Cassa'") &&
      page.includes('data.cash.pending_payments') &&
      page.includes('data.cash.pending_reconciliations'),
  ],
  [
    'azioni rapide operative',
    ['/sala', '/accoglienza', '/cucina', '/cassa', '/notifiche'].every((path) =>
      page.includes(`context.navigate('${path}')`) || page.includes(`path: '${path}'`)
    ),
  ],
  ['nessun KPI fatturato nella home', !/fatturato|revenue|receipts_cents|net_cents/i.test(page)],
  [
    'Admin può raggiungere KDS già autorizzata',
    app.includes("roles: ['ADMIN', 'KITCHEN_ADMIN', 'KITCHEN_STAFF']"),
  ],
  [
    'RPC server è Admin-only e scoped',
    migration.includes("array['ADMIN']::public.user_role[]") &&
      migration.includes('private.authorize(p_venue'),
  ],
  [
    'UI responsive e touch',
    read('styles/workspace-redesign.css').includes('.ops-body-grid') &&
      read('styles/workspace-redesign.css').includes('min-height: 44px') &&
      read('styles/workspace-redesign.css').includes('@media (max-width: 640px)'),
  ],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`ADMIN_UX_GATE=FAILED ${checks.length - failed}/${checks.length}`);
  process.exit(1);
}
console.log(`ADMIN_UX_GATE=PASSED ${checks.length}/${checks.length}`);
