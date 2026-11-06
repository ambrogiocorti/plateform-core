import { enqueueOrder } from '../offline/store';
import { z } from 'zod';
import { accountPrintAction } from './printing';
import { orderCorrectionButton } from './order-changes';
import { rpc } from '../api/client';
import { button, dialog, el, emptyState, status, toast } from '../components/dom';
import { orderComposer } from '../components/order-composer';
import { menuDishSchema, orderLineSchema } from '../types/domain';
import type { OrderLine } from '../types/domain';
import { validateOrderSelection } from '../services/menu';
import { formatMoney } from '../services/money';
import { accountWorkspaceSchema } from '../types/accounts';
import { accountList } from './account-list';
import { paymentDialog } from './account-payments';
import { billingSection } from './billing';
import { accountClosureActions, accountPaymentHistory } from './account-finance';
import type { StaffContext } from './staff-context';

export async function accountsPage(
  context: StaffContext,
  accountId?: string,
): Promise<HTMLElement> {
  if (!context.venue)
    return emptyState('Sede non disponibile', 'Verifica le assegnazioni del tuo account.');
  if (!accountId) return accountList(context);
  const workspace = await rpc(
    'get_account_workspace',
    { p_account: accountId },
    accountWorkspaceSchema,
  );
  const { account, balance } = workspace;
  if (account.venue_id !== context.venue.id)
    return emptyState('Conto in un’altra sede', 'Seleziona la sede del conto per aprirlo.');
  const view = el(
    'div',
    { class: 'stack account-detail' },
    el(
      'header',
      { class: 'row between account-detail-header' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, `${account.table_name} · ${account.covers} coperti`),
        el('h2', {}, account.account_name),
      ),
      status(account.status),
    ),
    el(
      'div',
      { class: 'kpi-grid account-balance-summary' },
      ...[
        ['Totale', balance.total_cents],
        ['Pagato', balance.paid_cents],
        ['Da saldare', balance.remaining_cents],
      ].map(([label, amount]) =>
        el(
          'section',
          { class: 'card' },
          el('p', { class: 'muted' }, String(label)),
          el('div', { class: 'amount' }, formatMoney(Number(amount))),
        ),
      ),
    ),
    balance.pending_cents
      ? el(
          'p',
          { role: 'status' },
          `Pagamenti in attesa: ${formatMoney(balance.pending_cents)}. Verifica l’esito prima di ripetere l’incasso.`,
        )
      : null,
  );
  const actions = el('div', { class: 'row account-detail-actions' });
  if (account.status === 'CLOSED' && account.unserved_items > 0)
    view.append(
      el(
        'p',
        { class: 'card', role: 'status' },
        'Conto chiuso contabilmente. La comanda resta in servizio e il tavolo sarà liberato dopo la consegna dei piatti.',
      ),
    );
  if (context.profile.role === 'WAITER' && ['OPEN', 'BILL_REQUESTED'].includes(account.status)) {
    actions.append(
      button('Aggiungi ordine', async () => orderDialog(context, account.id, account.version)),
      button(
        'Rigenera codice',
        async () => {
          const confirmation = dialog(
            'Rigenera il codice conto',
            el('p', {}, 'Il vecchio codice e gli accessi dei clienti saranno invalidati.'),
          );
          confirmation.append(
            button('Rigenera', async () => {
              const code = await rpc(
                'regenerate_account_code',
                { p_account: account.id },
                z.string(),
              );
              confirmation.close();
              dialog('Nuovo codice conto', el('p', { class: 'amount' }, code));
            }),
          );
        },
        'secondary',
      ),
    );
  }
  if (['ADMIN', 'CASHIER'].includes(context.profile.role)) {
    if (account.status !== 'CLOSED' && balance.available_cents > 0)
      actions.append(
        button('Registra pagamento', () =>
          paymentDialog(context, account.id, balance.available_cents),
        ),
      );
    actions.append(accountClosureActions(context, account, balance));
  }
  actions.append(await accountPrintAction(context, account.id));
  view.append(actions);
  const orderHistory = el('section', { class: 'stack' }, el('h2', {}, 'Ordini'));
  let cursor: { at: string; id: string } | null = null;
  const renderOrders = (orders: z.infer<typeof accountWorkspaceSchema>['orders']) => {
    for (const order of orders)
      orderHistory.append(
        el(
          'article',
          { class: 'card' },
          el(
            'div',
            { class: 'row between' },
            el('h3', {}, `Ordine · ${new Date(order.created_at).toLocaleString('it-IT')}`),
            status(order.status),
          ),
          orderCorrectionButton(context, account.id, order),
          ...order.items.map((item) =>
            el(
              'div',
              { class: 'configuration-row' },
              el('strong', {}, `${item.quantity} × ${item.dish_name}`),
              el('span', {}, formatMoney(item.quantity * item.unit_price_cents)),
              status(item.status),
            ),
          ),
        ),
      );
    const last = orders.at(-1);
    cursor = last ? { at: last.created_at, id: last.id } : null;
  };
  renderOrders(workspace.orders);
  const more = button(
    'Carica ordini precedenti',
    async () => {
      const page = await rpc(
        'get_account_workspace',
        { p_account: account.id, p_before_at: cursor?.at ?? null, p_before_id: cursor?.id ?? null },
        accountWorkspaceSchema,
      );
      renderOrders(page.orders);
      more.hidden = !page.has_more;
    },
    'secondary',
  );
  more.hidden = !workspace.has_more;
  const body = el(
    'div',
    { class: 'account-detail-body' },
    el('div', { class: 'stack' }, orderHistory, more),
  );
  if (['ADMIN', 'CASHIER'].includes(context.profile.role))
    body.append(
      el(
        'aside',
        { class: 'stack account-detail-finance', 'aria-label': 'Pagamenti e suddivisioni' },
        await billingSection(context, account),
        await accountPaymentHistory(context, account),
      ),
    );
  view.append(body);
  return view;
}

export async function orderDialog(
  context: StaffContext,
  account: string,
  version: number,
  submit?: (items: OrderLine[]) => Promise<void>,
): Promise<void> {
  const dishes = await rpc(
    'get_public_menu',
    { p_venue: context.venue?.id },
    z.array(menuDishSchema),
  );
  const composer = orderComposer(dishes);
  const key = crypto.randomUUID();
  const editor = dialog('Nuovo ordine');
  editor.classList.add('order-editor');
  editor.append(composer.root);
  editor.append(
    el(
      'footer',
      { class: 'cart-summary' },
      composer.summary,
      button('Invia ordine', async () => {
        if (!composer.reportValidity()) return;
        const selected = composer.items();
        if (!selected.length) {
          toast('Aggiungi almeno un piatto alla comanda.', true);
          return;
        }
        const items = z.array(orderLineSchema).min(1).parse(selected);
        for (const line of items) {
          const dish = dishes.find((entry) => entry.id === line.dish_id);
          if (!dish) throw new Error('DISH_UNAVAILABLE');
          const errors = validateOrderSelection(dish, line);
          if (errors.length) {
            toast(errors.join(' '), true);
            return;
          }
        }
        if (submit) {
          await submit(items);
          editor.close();
          return;
        }
        if (!navigator.onLine) {
          if (!context.venue) return;
          await enqueueOrder(context.venue.id, account, version, items);
          editor.close();
          toast('Ordine salvato in coda. L’invio alla cucina avverrà dopo la verifica del server.');
          context.navigate('/offline');
          return;
        }
        await rpc(
          'create_order',
          { p_account: account, p_items: items, p_key: key, p_version: version },
          z.object({ id: z.uuid() }),
        );
        editor.close();
        toast('Ordine inviato alla cucina.');
        context.navigate(`/conti/${account}`);
      }),
    ),
  );
}
