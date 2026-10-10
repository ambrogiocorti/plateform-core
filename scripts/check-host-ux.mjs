import fs from 'node:fs';
const host = fs.readFileSync('src/pages/host.ts', 'utf8');
const css = fs.readFileSync('styles/staff.css', 'utf8');
const migration = fs.readFileSync(
  'supabase/migrations/20261005165352_host_operational_summary.sql',
  'utf8',
);
const checks = [
  [
    'floor is first workspace child',
    host.includes("return el('div', { class: 'host-workspace' }, map, reservations)"),
  ],
  [
    'service kpis present',
    host.includes('host-service-kpis') &&
      host.includes("'ARRIVATI'") &&
      host.includes("'DA CONFERMARE'"),
  ],
  ['walk in is inline', host.includes('host-quick-form') && host.includes("'REGISTRA ARRIVO'")],
  ['arrival direct action', host.includes("button('ARRIVO', () => transition(entry, 'ARRIVED'))")],
  [
    'table assignment direct action',
    host.includes("button('ASSEGNA TAVOLO', () => chooseTable(entry))"),
  ],
  ['seat direct action', host.includes("button('ACCOMODA', () => transition(entry, 'SEATED'))")],
  [
    'table changes stay confirmed',
    host.includes("'Conferma cambio tavolo'") && host.includes('p_confirm_change: true'),
  ],
  [
    'authoritative rpc preserved',
    host.includes("'transition_reservation'") &&
      host.includes("'assign_table_group'") &&
      host.includes("'create_walk_in'"),
  ],
  [
    'parallel refresh floor and arrivals',
    host.includes('Promise.all([refresh(), refreshFloor()])'),
  ],
  [
    'summary counters ignore search status filters server side',
    migration.includes("and r.status='ARRIVED'") && migration.includes("and r.status='REQUESTED'"),
  ],
  [
    'server authorization preserved',
    migration.includes(
      "private.authorize(p_venue,array['ADMIN','HOST']::public.user_role[],false)",
    ),
  ],
  [
    'responsive touch layout',
    css.includes('.host-card-actions .button') &&
      css.includes('min-height: 48px') &&
      css.includes('@media (max-width: 700px)'),
  ],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exitCode = 1;
else console.log(`HOST_UX_GATE=PASSED ${checks.length}/${checks.length}`);
