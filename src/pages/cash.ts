import { z } from 'zod';
import { readPage, readRows, rpc } from '../api/client';
import { button, dialog, el, emptyState, field, showError, status, toast } from '../components/dom';
import { formatMoney, parseMoney } from '../services/money';
import { accountWorkspaceSchema } from '../types/accounts';
import { accountPrintAction } from './printing';
import { paymentDialog } from './account-payments';
import { accountClosureActions } from './account-finance';
import { mayResolveManualPayment, resolveManualPayment } from './manual-payment-resolution';
import { command } from './staff-context';
import type { StaffContext } from './staff-context';
import { reconciliationDialog } from './reconciliation';

const accountSearchRowSchema = z.object({
  id: z.uuid(),
  account_name: z.string(),
  table_name: z.string(),
  covers: z.number().int(),
  status: z.string(),
  created_at: z.string(),
});

const recentPaymentSchema = z.object({
  id: z.uuid(),
  cash_register_id: z.uuid(),
  register_name: z.string(),
  method: z.string(),
  amount_cents: z.number().int(),
  tip_cents: z.number().int(),
  status: z.string(),
  created_at: z.string(),
  refunded_cents: z.number().int(),
  refunded_tip_cents: z.number().int(),
  refunds: z.array(z.unknown()),
});

export async function cashPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venue) return emptyState('Nessuna sede', 'Seleziona una sede autorizzata.');

  const venueId = context.venue.id;
  const view = el('div', { class: 'stack cashier-page' });
  const search = field('Cerca conto, tavolo o ID · F2', 'cashier-search');
  search.input.placeholder = 'Es. Tavolo 12, Rossi o ID conto';
  search.input.maxLength = 100;
  search.input.autocomplete = 'off';
  search.input.setAttribute('enterkeyhint', 'search');

  const searchFeedback = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const searchResults = el('div', { class: 'cashier-search-results', role: 'list' });
  const accountWorkspace = el('section', {
    class: 'cashier-account-workspace',
    'aria-live': 'polite',
  });
  const secondary = el('section', { class: 'stack cashier-secondary' });

  let selectedAccountId: string | null = null;
  let accountRevision = 0;
  let searchRevision = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  async function searchAccounts(): Promise<void> {
    const revision = ++searchRevision;
    const query = search.input.value.trim();
    if (query.length === 1) {
      searchResults.replaceChildren();
      searchFeedback.textContent = 'Digita almeno 2 caratteri.';
      return;
    }
    searchFeedback.textContent = query ? 'Ricerca conti…' : 'Caricamento conti attivi…';
    const result = await rpc(
      'search_accounts',
      {
        p_venue: venueId,
        p_table: null,
        p_search: query,
        p_status: 'ACTIVE',
        p_from: null,
        p_to: null,
        p_before_at: null,
        p_before_id: null,
        p_limit: 20,
      },
      z.object({ items: z.array(accountSearchRowSchema), has_more: z.boolean() }),
    );
    if (revision !== searchRevision) return;
    searchResults.replaceChildren();
    for (const account of result.items) {
      const open = button(
        `${account.table_name} · ${account.account_name}`,
        () => loadAccount(account.id),
        'quiet',
      );
      open.classList.add('cashier-search-result');
      open.append(
        el('span', { class: 'cashier-search-result-meta' }, `${account.covers} coperti`),
        status(account.status),
      );
      // The list item wraps the button so assistive technology still announces it as actionable.
      searchResults.append(el('div', { role: 'listitem', class: 'cashier-search-item' }, open));
    }
    searchFeedback.textContent = result.items.length
      ? `${result.items.length} conti ${query ? 'trovati' : 'attivi'}${result.has_more ? ' · cerca per tavolo o nome per altri risultati' : ''}.`
      : query
        ? 'Nessun conto attivo corrisponde alla ricerca.'
        : 'Nessun conto attivo da incassare.';
  }

  async function loadAccount(accountId: string): Promise<void> {
    const revision = ++accountRevision;
    selectedAccountId = accountId;
    accountWorkspace.replaceChildren(
      el('p', { class: 'loading', role: 'status' }, 'Caricamento conto…'),
    );
    const [workspace, paymentPage] = await Promise.all([
      rpc('get_account_workspace', { p_account: accountId }, accountWorkspaceSchema),
      rpc(
        'get_account_payments',
        { p_account: accountId, p_before_at: null, p_before_id: null, p_limit: 6 },
        z.object({ items: z.array(recentPaymentSchema), has_more: z.boolean() }),
      ),
    ]);
    // A slower request for the previously selected account must never
    // overwrite the more recent account's balance or payment controls.
    if (revision !== accountRevision || selectedAccountId !== accountId) return;
    if (workspace.account.venue_id !== venueId) {
      selectedAccountId = null;
      accountWorkspace.replaceChildren(
        emptyState('Conto non disponibile', 'Il conto appartiene a un’altra sede.'),
      );
      return;
    }

    const { account, balance } = workspace;
    const refreshSelected = async () => {
      if (selectedAccountId === account.id) await loadAccount(account.id);
      await Promise.all([refreshSecondary(), searchAccounts()]);
    };

    const primaryActions = el('div', { class: 'cashier-primary-actions' });
    const pay = button('NUOVO PAGAMENTO · F4', () =>
      paymentDialog(context, account.id, balance.available_cents, [], undefined, refreshSelected),
    );
    pay.disabled = account.status === 'CLOSED' || balance.available_cents <= 0;
    if (pay.disabled)
      pay.title =
        balance.pending_cents > 0
          ? 'Verifica prima il pagamento in attesa.'
          : 'Il conto non ha saldo disponibile da incassare.';
    primaryActions.append(
      pay,
      button('DIVIDI / PRODOTTI', () => context.navigate(`/conti/${account.id}`), 'secondary'),
      accountClosureActions(context, account, balance, refreshSelected),
      await accountPrintAction(context, account.id),
    );

    const productRows = workspace.orders.flatMap((order) =>
      order.items.map((item) => ({ ...item, order_status: order.status })),
    );
    const products = el(
      'section',
      { class: 'cashier-detail-panel stack' },
      el('h3', {}, 'Prodotti'),
    );
    if (!productRows.length)
      products.append(el('p', { class: 'muted' }, 'Nessun prodotto sul conto.'));
    for (const item of productRows.slice(0, 16))
      products.append(
        el(
          'div',
          { class: 'cashier-line' },
          el('span', {}, `${item.quantity} × ${item.dish_name}`),
          el('strong', {}, formatMoney(item.quantity * item.unit_price_cents)),
          status(item.status),
        ),
      );
    if (productRows.length > 16)
      products.append(
        el(
          'p',
          { class: 'muted' },
          `Altri ${productRows.length - 16} prodotti nello storico completo.`,
        ),
      );

    const payments = el(
      'section',
      { class: 'cashier-detail-panel stack' },
      el('h3', {}, 'Ultimi pagamenti'),
    );
    if (!paymentPage.items.length)
      payments.append(el('p', { class: 'muted' }, 'Nessun pagamento registrato.'));
    for (const payment of paymentPage.items) {
      const entry = el(
        'div',
        { class: 'cashier-line' },
        el('span', {}, `${payment.method.replaceAll('_', ' ')} · ${payment.register_name}`),
        el('strong', {}, formatMoney(payment.amount_cents + payment.tip_cents)),
        status(payment.status),
      );
      if (mayResolveManualPayment(payment))
        entry.append(
          button(
            'Riprendi verifica',
            () => resolveManualPayment(payment, refreshSelected),
            'secondary',
          ),
        );
      payments.append(entry);
    }
    if (paymentPage.has_more)
      payments.append(
        button('Storico completo', () => context.navigate(`/conti/${account.id}`), 'quiet'),
      );

    accountWorkspace.replaceChildren(
      el(
        'div',
        { class: 'cashier-account-head' },
        el(
          'div',
          {},
          el('p', { class: 'eyebrow' }, account.table_name),
          el('h2', {}, account.account_name),
          el('p', { class: 'muted' }, `${account.covers} coperti`),
        ),
        status(account.status),
      ),
      el(
        'div',
        { class: 'cashier-balance-grid' },
        moneyKpi('TOTALE', balance.total_cents),
        moneyKpi('PAGATO', balance.paid_cents),
        moneyKpi('RESIDUO', balance.remaining_cents, 'cashier-kpi-primary'),
        moneyKpi(
          'IN ATTESA',
          balance.pending_cents,
          balance.pending_cents ? 'cashier-kpi-warning' : '',
        ),
      ),
      ...(balance.pending_cents > 0
        ? [
            el(
              'div',
              { class: 'cashier-warning', role: 'alert' },
              `Pagamento in attesa: ${formatMoney(balance.pending_cents)}. Verifica l’esito prima di creare un nuovo incasso sullo stesso saldo.`,
            ),
          ]
        : []),
      ...(account.unserved_items > 0
        ? [
            el(
              'div',
              { class: 'cashier-warning', role: 'status' },
              `${account.unserved_items} piatti risultano ancora non serviti. La chiusura contabile è separata dalla consegna al tavolo.`,
            ),
          ]
        : []),
      primaryActions,
      el('div', { class: 'cashier-account-details' }, products, payments),
    );
  }

  async function refreshSecondary(): Promise<void> {
    const serviceSchema = z.object({ id: z.uuid(), opened_at: z.string(), status: z.string() });
    const [registers, services, registerSessions, pendingPayments] = await Promise.all([
      readRows(
        'cash_registers',
        z.object({ id: z.uuid(), name: z.string(), code: z.string(), status: z.string() }),
        venueId,
      ),
      readRows('service_sessions', serviceSchema, venueId, {
        status: ['OPEN', 'RECONCILING', 'AWAITING_APPROVAL'],
      }),
      readRows(
        'cash_register_sessions',
        z.object({ cash_register_id: z.uuid(), closed_at: z.string().nullable() }),
        venueId,
        { closed_at: null },
      ),
      readRows(
        'payments',
        z.object({
          id: z.uuid(),
          account_id: z.uuid(),
          cash_register_id: z.uuid(),
          method: z.string(),
          amount_cents: z.number(),
          tip_cents: z.number(),
          status: z.string(),
        }),
        venueId,
        { status: 'PENDING' },
      ),
    ]);

    const registerGrid = el('div', { class: 'grid' });
    for (const register of registers)
      registerGrid.append(
        el(
          'article',
          { class: 'card stack' },
          el('div', { class: 'row between' }, el('h3', {}, register.name), status(register.status)),
          el('p', { class: 'muted' }, register.code),
          button(
            register.status === 'OPEN' ? 'Chiudi postazione' : 'Apri postazione',
            async () => {
              await command('set_cash_register_open', {
                p_register: register.id,
                p_open: register.status !== 'OPEN',
              });
              await refreshSecondary();
            },
            'secondary',
          ),
          register.status === 'OPEN' &&
            !registerSessions.some(
              (entry) => entry.cash_register_id === register.id && !entry.closed_at,
            )
            ? button(
                'Apri servizio contabile',
                () => openService(register.id, register.name),
                'secondary',
              )
            : null,
        ),
      );

    const servicesSection = el('section', { class: 'stack' }, el('h3', {}, 'Servizi contabili'));
    if (!services.length)
      servicesSection.append(el('p', { class: 'muted' }, 'Nessun servizio contabile aperto.'));
    for (const service of services)
      servicesSection.append(
        el(
          'article',
          { class: 'card row between' },
          el(
            'div',
            {},
            el('p', {}, `Aperto il ${new Date(service.opened_at).toLocaleString('it-IT')}`),
            status(service.status),
          ),
          button(
            service.status === 'AWAITING_APPROVAL'
              ? 'Verifica differenza'
              : 'Quadratura e chiusura',
            () => reconciliationDialog(context, service.id),
            'secondary',
          ),
        ),
      );

    const history = el('div', { class: 'stack' });
    let cursor: string | null = null;
    const more = button(
      'Carica quadrature concluse',
      async () => {
        const page = await readPage('service_sessions', serviceSchema, {
          venue: venueId,
          filters: { status: 'CLOSED' },
          after: cursor,
          limit: 25,
        });
        for (const service of page.rows)
          history.append(
            button(
              `Servizio del ${new Date(service.opened_at).toLocaleString('it-IT')}`,
              () => reconciliationDialog(context, service.id),
              'secondary',
            ),
          );
        cursor = page.next;
        more.hidden = !cursor;
        if (!page.rows.length)
          history.append(el('p', { class: 'muted' }, 'Nessun servizio concluso disponibile.'));
      },
      'quiet',
    );

    const pendingSection = el(
      'section',
      { class: 'stack' },
      el('h3', {}, `Incassi da verificare · ${pendingPayments.length}`),
    );
    if (!pendingPayments.length)
      pendingSection.append(el('p', { class: 'muted' }, 'Non ci sono pagamenti in attesa.'));
    for (const payment of pendingPayments) {
      const card = el(
        'article',
        { class: 'card stack' },
        el(
          'div',
          { class: 'row between' },
          el('strong', {}, formatMoney(payment.amount_cents + payment.tip_cents)),
          status(payment.method),
        ),
        el(
          'p',
          { class: 'muted' },
          `Conto ${formatMoney(payment.amount_cents)} · mancia ${formatMoney(payment.tip_cents)}`,
        ),
      );
      const pending = {
        ...payment,
        register_name:
          registers.find((row) => row.id === payment.cash_register_id)?.name ??
          'Cassa non disponibile',
      };
      if (mayResolveManualPayment(pending))
        card.append(
          button(
            'Riprendi verifica manuale',
            () =>
              resolveManualPayment(pending, async () => {
                await refreshSecondary();
                if (selectedAccountId === payment.account_id) await loadAccount(payment.account_id);
              }),
            'secondary',
          ),
        );
      else
        card.append(
          el(
            'p',
            { class: 'muted' },
            'Questo metodo non è confermabile manualmente nell’edizione CORE. Apri lo storico del conto per verificare le opzioni disponibili.',
          ),
          button(
            'Apri storico conto',
            () => context.navigate(`/conti/${payment.account_id}`),
            'quiet',
          ),
        );
      pendingSection.append(card);
    }

    // Keep the panel open across refreshes, and open it while no accounting service is running:
    // opening the register and the service are the cashier's first actions of the day.
    const operations = el(
      'details',
      { class: 'cashier-operations' },
      el('summary', {}, 'Postazioni, servizi e verifiche'),
      el(
        'div',
        { class: 'stack cashier-operations-body' },
        registers.length
          ? registerGrid
          : emptyState(
              'Nessuna cassa configurata',
              'L’amministratore può aggiungere le postazioni e assegnare gli operatori.',
            ),
        servicesSection,
        history,
        more,
        pendingSection,
      ),
    );
    operations.open =
      secondary.querySelector<HTMLDetailsElement>('details.cashier-operations')?.open === true ||
      !services.length;
    secondary.replaceChildren(operations);
  }

  function openService(registerId: string, registerName: string): void {
    const initialFloat = field('Fondo iniziale', 'float', 'text', '0,00');
    initialFloat.input.inputMode = 'decimal';
    const editor = dialog(`Apri servizio · ${registerName}`, initialFloat.root);
    const key = crypto.randomUUID();
    editor.append(
      button('Apri servizio', async () => {
        await rpc(
          'open_service_session',
          {
            p_venue: venueId,
            p_service: null,
            p_register: registerId,
            p_float: Number(parseMoney(initialFloat.input.value)),
            p_key: key,
          },
          z.object({ id: z.uuid() }),
        );
        editor.close();
        toast('Servizio di cassa aperto.');
        await refreshSecondary();
      }),
    );
  }

  function moneyKpi(label: string, cents: number, extraClass = ''): HTMLElement {
    return el(
      'article',
      { class: `cashier-kpi ${extraClass}`.trim() },
      el('span', {}, label),
      el('strong', {}, formatMoney(cents)),
    );
  }

  search.input.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void searchAccounts().catch(showError), 180);
  });
  search.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void searchAccounts().catch(showError);
    }
  });

  const shortcutController = new AbortController();
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'F2') {
        event.preventDefault();
        search.input.focus();
        search.input.select();
      }
      if (event.key === 'F4' && selectedAccountId) {
        event.preventDefault();
        const pay = accountWorkspace.querySelector<HTMLButtonElement>(
          '.cashier-primary-actions .button',
        );
        if (pay && !pay.disabled) pay.click();
      }
    },
    { signal: shortcutController.signal },
  );
  const cleanup = new MutationObserver(() => {
    if (!view.isConnected) {
      shortcutController.abort();
      cleanup.disconnect();
    }
  });
  cleanup.observe(document.body, { childList: true, subtree: true });

  const commandCenter = el(
    'section',
    { class: 'cashier-command-center' },
    el(
      'div',
      { class: 'cashier-search-pane' },
      el('p', { class: 'eyebrow' }, 'INCASSO'),
      el('h2', {}, 'Trova un conto'),
      search.root,
      searchFeedback,
      searchResults,
    ),
    accountWorkspace,
  );

  view.append(commandCenter, secondary);
  accountWorkspace.append(
    emptyState(
      'Seleziona un conto',
      'Seleziona un conto attivo dall’elenco oppure cerca per tavolo, nome cliente o ID.',
    ),
  );

  context.refresh = async () => {
    await Promise.all([
      refreshSecondary(),
      searchAccounts(),
      selectedAccountId ? loadAccount(selectedAccountId) : Promise.resolve(),
    ]);
  };

  await Promise.all([refreshSecondary(), searchAccounts()]);
  return view;
}
