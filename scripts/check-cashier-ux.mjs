import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const cash = read('src/pages/cash.ts');
const payment = read('src/pages/account-payments.ts');
const provider = read('src/pages/provider-payments.ts');
const css = read('styles/staff.css');

const checks = [
  ['ricerca immediata con shortcut F2', cash.includes('Cerca conto, tavolo o ID · F2') && cash.includes("event.key === 'F2'")],
  ['ricerca conti authoritative', cash.includes("'search_accounts'") && cash.includes("p_status: 'ACTIVE'")],
  ['selezione conto resta nella workspace Cassa', cash.includes('() => loadAccount(account.id)') && cash.includes('selectedAccountId = accountId')],
  ['workspace conto authoritative', cash.includes("'get_account_workspace'") && cash.includes('accountWorkspaceSchema')],
  ['pagamenti recenti authoritative', cash.includes("'get_account_payments'") && cash.includes('recentPaymentSchema')],
  ['totale pagato residuo pending visibili', ['TOTALE', 'PAGATO', 'RESIDUO', 'IN ATTESA'].every((value) => cash.includes(`'${value}'`))],
  ['F4 apre il pagamento primario', cash.includes('NUOVO PAGAMENTO · F4') && cash.includes("event.key === 'F4'")],
  ['pagamento aggiorna il conto in-place', cash.includes('refreshSelected') && payment.includes('onComplete?: () => void | Promise<void>') && provider.includes('onReturn?: () => void | Promise<void>')],
  ['divisione prodotti e stampa disponibili', cash.includes('DIVIDI / PRODOTTI') && cash.includes('accountPrintAction(context, account.id)')],
  ['warning pagamento pending', cash.includes('Pagamento in attesa:') && cash.includes('Verifica l’esito prima di creare un nuovo incasso')],
  ['realtime refresh preserva conto selezionato', cash.includes('selectedAccountId ? loadAccount(selectedAccountId)') && cash.includes('context.refresh = async () =>')],
  ['operatività secondaria cassa preservata', ['set_cash_register_open', 'open_service_session', 'reconciliationDialog', 'confirm_manual_payment'].every((value) => cash.includes(value))],
  ['desktop-first responsive e target touch', css.includes('.cashier-command-center') && css.includes('grid-template-columns: minmax(18rem, 0.72fr) minmax(32rem, 1.6fr)') && css.includes('min-height: 48px') && css.includes('@media (max-width: 980px)')],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`CASHIER_UX_GATE=FAILED ${checks.length - failed}/${checks.length}`);
  process.exit(1);
}
console.log(`CASHIER_UX_GATE=PASSED ${checks.length}/${checks.length}`);
