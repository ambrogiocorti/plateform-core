import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const context = read('src/pages/staff-context.ts');
const app = read('apps/staff/main.ts');
const stats = read('src/pages/statistics.ts');
const staff = read('src/pages/staff-management.ts');
const config = read('src/pages/configuration.ts');
const catalog = read('src/pages/catalog.ts');

const checks = [
  [
    'MULTI_VENUE controlla la complessità UI',
    context.includes("flag.name === 'MULTI_VENUE' && flag.licensed"),
  ],
  [
    'una sola sede autorizzata viene selezionata automaticamente',
    context.includes('venues.find((venue) => venue.id === selected) ?? venues[0] ?? null'),
  ],
  [
    'switcher solo con licenza e più sedi',
    app.includes('context.multiVenue && context.venues.length > 1'),
  ],
  [
    'switcher usa solo context.venues autorizzate',
    app.includes('...context.venues.map((venue) =>'),
  ],
  [
    'selezione sede confermata dal server e persistita per sessione',
    /await rpc\('set_operational_venue', \{ p_venue: venue \}, venueContextSchema\);\s*sessionStorage\.setItem\('plateform-venue', venue\);/.test(
      context,
    ) && app.includes('selectVenue(venueControl.value)'),
  ],
  [
    'aggregato statistiche solo CHAIN multi-sede',
    stats.includes("context.profile.scope === 'CHAIN' && context.multiVenue") &&
      stats.includes('Tutte le sedi autorizzate'),
  ],
  [
    'RPC statistiche usa null solo per aggregato scelto',
    stats.includes('p_venue: scope.value || null'),
  ],
  [
    'Admin VENUE non può scegliere CHAIN nello staff editor',
    staff.includes(
      "context.profile.scope === 'CHAIN' ? el('option', { value: 'CHAIN' }, 'Intera catena') : null",
    ),
  ],
  [
    'config condivisa nascosta a VENUE quando multi-sede',
    config.includes("!module.shared || context.profile.scope === 'CHAIN' || !context.multiVenue"),
  ],
  [
    'catalogo legge override venue_dish_settings',
    catalog.includes("readRows('venue_dish_settings'") && catalog.includes("'save_venue_dish'"),
  ],
  [
    'palette cambia sede solo se già autorizzata',
    app.includes('currentContext?.venues.some((venue) => venue.id === hit.venue_id)') &&
      app.includes('await selectVenue(hit.venue_id);'),
  ],
  [
    'ricerca operativa resta scoped alla sede corrente',
    app.includes('p_venue: currentContext?.venue?.id ?? null'),
  ],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`STEP10_MULTIVENUE_UX_GATE=FAILED ${checks.length - failed}/${checks.length}`);
  process.exit(1);
}
console.log(`STEP10_MULTIVENUE_UX_GATE=PASSED ${checks.length}/${checks.length}`);
