import fs from 'node:fs';
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
const editor=read('src/pages/room-editor.ts');
const devices=read('src/pages/devices.ts');
const app=read('apps/staff/main.ts');
const stats=read('src/pages/statistics.ts');

const checks=[
 ['Room Editor usa pointer drag', editor.includes("svg.addEventListener('pointerdown'") && editor.includes("svg.addEventListener('pointermove'")],
 ['Room Editor resize', editor.includes("data-resize") && editor.includes('resizeId: drag.resize')],
 ['Room Editor zoom', editor.includes('zoom = Math.max(0.25') && editor.includes('zoom = Math.min(4')],
 ['Room Editor snap', editor.includes('snapped(') && editor.includes('snap = grid.checked')],
 ['Room Editor livelli', editor.includes('e.layer + 1') && editor.includes('e.layer - 1')],
 ['Room Editor undo redo', editor.includes('history.undo()') && editor.includes('history.redo()')],
 ['Room Editor salvataggio e attivazione authoritative', editor.includes("'save_room_layout'") && editor.includes("'activate_room_layout'")],
 ['Device Management workspace', devices.includes("'get_device_management'") && devices.includes('last_seen_at') && devices.includes('online')],
 ['Device revocation richiede step-up', devices.includes("stepUp('DEVICE_REVOKE'") && devices.includes("'revoke_device'")],
 ['heartbeat device applicativo', app.includes("rpc('heartbeat_device', {}, z.boolean())")],
 ['Command Palette ricerca server-side', app.includes("'search_operational_resources'") && app.includes('Risultati autorizzati')],
 ['Command Palette non cambia sede fuori scope', app.includes('currentContext?.venues.some((venue) => venue.id === hit.venue_id)')],
 ['Analytics usa RPC authoritative', stats.includes("'get_operational_statistics'")],
 ['Analytics supporta CHAIN solo per scope CHAIN', stats.includes("context.profile.scope === 'CHAIN' && context.multiVenue")],
 ['Analytics esporta snapshot corrente', stats.includes('Esporta report CSV') && stats.includes('snapshotDates')],
 ['Analytics include tempi cucina/chiamate e capacità', stats.includes('preparation_seconds') && stats.includes('call_acceptance_seconds') && stats.includes('capacity_services')],
];
let failed=0;for(const [label,ok] of checks){console.log(`${ok?'PASS':'FAIL'} — ${label}`);if(!ok)failed++;}
if(failed){console.error(`STEP9_ADVANCED_UX_GATE=FAILED ${checks.length-failed}/${checks.length}`);process.exit(1);}
console.log(`STEP9_ADVANCED_UX_GATE=PASSED ${checks.length}/${checks.length}`);
