import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const cash = read('src/pages/cash.ts');
const payment = read('src/pages/account-payments.ts');
const provider = read('src/pages/provider-payments.ts');
const manualPayment = read('src/pages/manual-payment-resolution.ts');
const settlement = read('src/services/account-settlement.ts');

const checks = [
  [
    'ricerca immediata con shortcut F2',
    cash.includes('Cerca conto, tavolo o ID · F2') && cash.includes("event.key === 'F2'"),
  ],
  [
    'ricerca conti authoritative',
    cash.includes("'search_accounts'") && cash.includes("p_status: 'ACTIVE'"),
  ],
  [
    'selezione conto resta nella workspace Cassa',
    cash.includes('() => loadAccount(account.id)') &&
      cash.includes('selectedAccountId = accountId'),
  ],
  [
    'workspace conto authoritative',
    cash.includes("'get_account_workspace'") && cash.includes('accountWorkspaceSchema'),
  ],
  [
    'pagamenti recenti authoritative',
    cash.includes("'get_account_payments'") && cash.includes('recentPaymentSchema'),
  ],
  [
    'totale pagato residuo pending visibili',
    ['TOTALE', 'PAGATO', 'RESIDUO', 'IN ATTESA'].every((value) => cash.includes(`'${value}'`)),
  ],
  [
    'F4 apre il pagamento primario',
    cash.includes('NUOVO PAGAMENTO · F4') && cash.includes("event.key === 'F4'"),
  ],
  [
    'pagamento aggiorna il conto in-place',
    cash.includes('refreshSelected') &&
      payment.includes('onComplete?: () => void | Promise<void>') &&
      provider.includes('onReturn?: () => void | Promise<void>'),
  ],
  [
    'divisione prodotti e stampa disponibili',
    cash.includes('DIVIDI / PRODOTTI') && cash.includes('accountPrintAction(context, account.id)'),
  ],
  [
    'warning pagamento pending',
    cash.includes('Pagamento in attesa:') &&
      cash.includes('Verifica l’esito prima di creare un nuovo incasso'),
  ],
  [
    'realtime refresh preserva conto selezionato',
    cash.includes('selectedAccountId ? loadAccount(selectedAccountId)') &&
      cash.includes('context.refresh = async () =>'),
  ],
  [
    'operatività secondaria cassa preservata',
    ['set_cash_register_open', 'open_service_session', 'reconciliationDialog'].every((value) =>
      cash.includes(value),
    ) &&
      cash.includes('resolveManualPayment') &&
      manualPayment.includes("'confirm_manual_payment'") &&
      manualPayment.includes('if (!mayResolveManualPayment(payment)) return') &&
      settlement.includes('permittedPaymentMethod(payment.method)'),
  ],
  [
    'desktop-first responsive e target touch',
    read('styles/frontdesk-v4.css').includes('.cashier-command-center') &&
      read('styles/frontdesk-v4.css').includes('minmax(290px, 0.72fr)') &&
      read('styles/frontdesk-v4.css').includes('min-height: 43px') &&
      read('styles/frontdesk-v4.css').includes('@media (max-width: 950px)'),
  ],
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
