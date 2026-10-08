import fs from 'node:fs';
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
const app=read('apps/staff/main.ts');
const page=read('src/pages/technical.ts');
const css=read('styles/staff.css');
const base=read('supabase/migrations/20261004161807_step12_operational_release_baseline.sql');

const checks=[
 ['salute è prima landing Super Admin', app.indexOf("path: '/salute'") < app.indexOf("path: '/dispositivi'") && app.includes("label: 'Operational Health'" )],
 ['home usa workspace tecnico', page.includes("'get_technical_workspace'")],
 ['stato globale operativo esplicito', page.includes("'CRITICAL'") && page.includes("'ATTENZIONE'") && page.includes("'DA VERIFICARE'") && page.includes("'OPERATIVO'" )],
 ['core Supabase 5 servizi', ['DATABASE','AUTH','REALTIME','STORAGE','EDGE'].every((x)=>page.includes(`'${x}'`)) && page.includes('CORE SUPABASE')],
 ['versione e schema', page.includes("'VERSIONE'") && page.includes('data.schema_version')],
 ['error rate e p95', page.includes('EDGE ERROR RATE') && page.includes('LATENZA P95') && page.includes('data.metrics.error_percent')],
 ['device recenti e autorizzati', page.includes("'DISPOSITIVI'") && page.includes('data.usage.recent_devices') && page.includes('data.usage.devices')],
 ['queue e conflitti', page.includes('CODE / CONFLITTI') && page.includes('data.queues.sync_conflicts')],
 ['backup e restore', page.includes("'RPO'") && page.includes("'RESTORE'") && page.includes('data.backup_health.rpo_within_target')],
 ['scorciatoie tecniche', ['SERVIZI','CONTINUITÀ','CODE','DISPOSITIVI','AUDIT'].every((x)=>page.includes(`'${x}'`))],
 ['nessun fatturato nella hero', page.includes('Nessun KPI economico del ristorante.') && !/receipts_cents|average_check_cents/.test(page.slice(page.indexOf('const operationalHealth'), page.indexOf('view.append(operationalHealth)')+40))],
 ['workspace base privata Super Admin', base.includes('private.technical_workspace_base') && base.includes("array['SUPER_ADMIN']::public.user_role[]")],
 ['health mancante non diventa verde', page.includes('hasUnknown') && page.includes("!probe || !fresh(probe.checked_at)")],
 ['layout health responsive', css.includes('.technical-health-grid') && css.includes('@media (max-width: 650px)')],
];
let failed=0; for(const [label,ok] of checks){console.log(`${ok?'PASS':'FAIL'} — ${label}`);if(!ok)failed++;}
if(failed){console.error(`SUPER_ADMIN_UX_GATE=FAILED ${checks.length-failed}/${checks.length}`);process.exit(1);}
console.log(`SUPER_ADMIN_UX_GATE=PASSED ${checks.length}/${checks.length}`);
