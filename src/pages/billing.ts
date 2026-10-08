import { z } from 'zod';
import { equalPlanSchema, equalSplitSection } from './equal-split';
import { transferDialog } from './transfers';
import { rpc } from '../api/client';
import { stepUp } from '../auth/step-up';
import { button, dialog, el, field, status, toast } from '../components/dom';
import { formatMoney, parseMoney } from '../services/money';
import type { Account } from '../types/accounts';
import { paymentDialog } from './account-payments';
import type { StaffContext } from './staff-context';

const itemSchema = z.object({
  order_item_id: z.uuid(),
  dish_name: z.string(),
  quantity: z.number().int(),
  gross_cents: z.number().int(),
  discount_cents: z.number().int(),
  net_cents: z.number().int(),
  paid_cents: z.number().int(),
  pending_cents: z.number().int(),
  available_cents: z.number().int(),
  selectable_quantity: z.number().int(),
  units: z.array(
    z.object({
      number: z.number().int(),
      available_cents: z.number().int(),
      pending_cents: z.number().int(),
      paid_cents: z.number().int(),
    }),
  ),
});
const requestSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  reason: z.string(),
  quoted_amount_cents: z.number().int(),
  status: z.string(),
});
const workspaceSchema = z.object({
  equal_split: equalPlanSchema.nullable().optional(),
  version: z.number().int(),
  discount_policy: z.string(),
  complimentary_policy: z.string(),
  items: z.array(itemSchema),
  requests: z.array(requestSchema),
});
const quoteSchema = z.object({
  version: z.number().int(),
  amount_cents: z.number().int(),
  policy: z.string(),
});
type Workspace = z.infer<typeof workspaceSchema>;
const labels: Record<string, string> = {
  FIXED: 'Sconto fisso',
  PERCENT: 'Sconto percentuale',
  ITEM_COMPLIMENTARY: 'Piatto offerto',
  ACCOUNT_COMPLIMENTARY: 'Saldo conto offerto',
};

export async function billingSection(
  context: StaffContext,
  account: Account,
): Promise<HTMLElement> {
  const data = await rpc('get_billing_workspace', { p_account: account.id }, workspaceSchema);
  const view = el('section', { class: 'stack' }, el('h2', {}, 'Addebiti e divisione per prodotti'));
  const selected = new Map<string, number>(),
    total = el('p', { class: 'amount' }, formatMoney(0));
  function refreshTotal(): void {
    let cents = 0;
    for (const item of data.items)
      cents += item.units
        .filter((unit) => unit.pending_cents === 0 && unit.available_cents > 0)
        .slice(0, selected.get(item.order_item_id) ?? 0)
        .reduce((sum, unit) => sum + unit.available_cents, 0);
    total.textContent = `Prodotti selezionati ${formatMoney(cents)}`;
  }
  for (const item of data.items) {
    const card = el(
      'article',
      { class: 'card stack' },
      el('h3', {}, `${item.quantity} × ${item.dish_name}`),
      el(
        'p',
        {},
        `Lordo ${formatMoney(item.gross_cents)} · Sconti ${formatMoney(item.discount_cents)} · Netto ${formatMoney(item.net_cents)}`,
      ),
      el(
        'p',
        {},
        `Pagato ${formatMoney(item.paid_cents)} · In attesa ${formatMoney(item.pending_cents)} · Disponibile ${formatMoney(item.available_cents)}`,
      ),
    );
    if (account.status !== 'CLOSED' && item.selectable_quantity > 0) {
      const quantity = field('Quantità da pagare', `pay-${item.order_item_id}`, 'number', '0');
      quantity.input.min = '0';
      quantity.input.max = String(item.selectable_quantity);
      quantity.input.step = '1';
      quantity.input.addEventListener('input', () => {
        const value = Number(quantity.input.value);
        if (Number.isInteger(value) && value >= 0 && value <= item.selectable_quantity)
          selected.set(item.order_item_id, value);
        else selected.delete(item.order_item_id);
        refreshTotal();
      });
      card.append(quantity.root);
    } else
      card.append(
        status(
          item.pending_cents > 0
            ? 'IN ATTESA'
            : item.available_cents === 0
              ? 'SALDATO O OFFERTO'
              : 'NON SELEZIONABILE',
        ),
      );
    view.append(card);
  }
  if (account.status !== 'CLOSED') {
    view.append(
      total,
      button(
        'Paga prodotti selezionati',
        async () => {
          if (Array.from(view.querySelectorAll('input')).some((input) => !input.reportValidity()))
            return;
          const items = Array.from(selected)
            .filter(([, quantity]) => quantity > 0)
            .map(([item_id, quantity]) => ({ item_id, quantity }));
          if (!items.length) {
            toast('Seleziona almeno un prodotto.', true);
            return;
          }
          const cents = items.reduce(
            (sum, selection) =>
              sum +
              data.items
                .find((item) => item.order_item_id === selection.item_id)!
                .units.filter((unit) => unit.pending_cents === 0 && unit.available_cents > 0)
                .slice(0, selection.quantity)
                .reduce((subtotal, unit) => subtotal + unit.available_cents, 0),
            0,
          );
          await paymentDialog(context, account.id, cents, items);
        },
        'secondary',
      ),
    );
    if (data.discount_policy !== 'DISABLED' || data.complimentary_policy !== 'DISABLED')
      view.append(
        button('Sconto o omaggio', () => discountDialog(context, account, data), 'secondary'),
      );
  }
  if (data.requests.length) view.append(el('h3', {}, 'Richieste di autorizzazione'));
  for (const request of data.requests)
    view.append(
      el(
        'article',
        { class: 'card stack' },
        el(
          'h3',
          {},
          `${labels[request.kind] ?? request.kind} · ${formatMoney(request.quoted_amount_cents)}`,
        ),
        el('p', {}, request.reason),
        status('IN ATTESA ADMIN'),
        context.profile.role === 'ADMIN'
          ? el(
              'div',
              { class: 'row' },
              button(
                'Verifica e approva',
                () => decisionDialog(context, account, request.id, true),
                'secondary',
              ),
              button(
                'Rifiuta richiesta',
                () => decisionDialog(context, account, request.id, false),
                'quiet',
              ),
            )
          : null,
      ),
    );
  view.append(equalSplitSection(context, account, data.equal_split ?? null));
  if (account.status !== 'CLOSED')
    view.append(
      button(
        'Sposta prodotti o unisci conti',
        () => transferDialog(context, account, data.items),
        'secondary',
      ),
    );
  return view;
}

function discountDialog(context: StaffContext, account: Account, data: Workspace): void {
  const kinds = [
    ...(data.discount_policy === 'DISABLED' ? [] : ['FIXED', 'PERCENT']),
    ...(data.complimentary_policy === 'DISABLED'
      ? []
      : ['ITEM_COMPLIMENTARY', 'ACCOUNT_COMPLIMENTARY']),
  ];
  const kind = el(
    'select',
    { 'aria-label': 'Tipo riduzione' },
    ...kinds.map((value) => el('option', { value }, labels[value]!)),
  );
  const value = field('Importo in euro o percentuale', 'value', 'text', '0,00');
  value.input.inputMode = 'decimal';
  const item = el(
    'select',
    { 'aria-label': 'Piatto da offrire' },
    ...data.items
      .filter((row) =>
        row.units.some(
          (unit) => unit.paid_cents === 0 && unit.pending_cents === 0 && unit.available_cents > 0,
        ),
      )
      .map((row) => el('option', { value: row.order_item_id }, row.dish_name)),
  );
  const quantity = field('Quantità da offrire', 'quantity', 'number', '1');
  quantity.input.min = '1';
  quantity.input.max = '999';
  quantity.input.step = '1';
  const reason = field('Motivo della riduzione', 'reason');
  reason.input.required = true;
  reason.input.minLength = 3;
  reason.input.maxLength = 2000;
  const itemField = el('label', { class: 'field' }, 'Piatto', item);
  const update = () => {
    value.root.hidden = !['FIXED', 'PERCENT'].includes(kind.value);
    itemField.hidden = quantity.root.hidden = kind.value !== 'ITEM_COMPLIMENTARY';
  };
  kind.addEventListener('change', update);
  update();
  const editor = dialog(
    'Sconto o omaggio',
    el('label', { class: 'field' }, 'Tipo', kind),
    value.root,
    itemField,
    quantity.root,
    reason.root,
    el(
      'p',
      { class: 'muted' },
      'La percentuale si applica al totale corrente. Il saldo offerto comprende solo gli importi ancora da pagare.',
    ),
  );
  editor.append(
    button('Calcola riduzione', async () => {
      if (!reason.input.reportValidity() || !quantity.input.reportValidity()) return;
      const items =
        kind.value === 'ITEM_COMPLIMENTARY'
          ? [{ item_id: item.value, quantity: Number(quantity.input.value) }]
          : [];
      const payload = {
        p_account: account.id,
        p_kind: kind.value,
        p_value: ['FIXED', 'PERCENT'].includes(kind.value)
          ? Number(parseMoney(value.input.value))
          : 0,
        p_items: items,
      };
      const quote = await rpc('preview_discount', payload, quoteSchema);
      const key = crypto.randomUUID();
      const reasonText = reason.input.value;
      const confirm = dialog(
        'Conferma riduzione',
        el('p', { class: 'amount' }, formatMoney(quote.amount_cents)),
        el('p', {}, reasonText),
        el(
          'p',
          {},
          quote.policy === 'CASHIER_AUTONOMOUS'
            ? 'La riduzione sarà applicata al conto.'
            : 'La richiesta sarà inviata all’Admin per autorizzazione.',
        ),
      );
      confirm.append(
        button(
          quote.policy === 'CASHIER_AUTONOMOUS' ? 'Applica riduzione' : 'Invia richiesta Admin',
          async () => {
            const result = await rpc(
              'request_discount',
              { ...payload, p_reason: reasonText, p_version: quote.version, p_key: key },
              z.object({ id: z.uuid(), status: z.string() }),
            );
            confirm.close();
            editor.close();
            toast(
              result.status === 'APPLIED' ? 'Riduzione applicata.' : 'Richiesta inviata all’Admin.',
            );
            context.navigate(`/conti/${account.id}`);
          },
        ),
      );
    }),
  );
}

async function decisionDialog(
  context: StaffContext,
  account: Account,
  request: string,
  approve: boolean,
): Promise<void> {
  const quote = approve
    ? await rpc('preview_discount_request', { p_request: request }, quoteSchema)
    : null;
  const reason = field('Motivo della decisione', 'decision');
  reason.input.required = true;
  reason.input.minLength = 3;
  reason.input.maxLength = 2000;
  const editor = dialog(
    approve ? 'Autorizza riduzione' : 'Rifiuta riduzione',
    quote ? el('p', { class: 'amount' }, formatMoney(quote.amount_cents)) : null,
    el(
      'p',
      {},
      approve
        ? 'Importo ricalcolato sul conto corrente. La conferma richiede la tua password.'
        : 'Il conto manterrà gli importi attuali.',
    ),
    reason.root,
  );
  const key = crypto.randomUUID();
  editor.append(
    button(approve ? 'Conferma autorizzazione' : 'Conferma rifiuto', async () => {
      if (!reason.input.reportValidity()) return;
      const proof = await stepUp('DISCOUNT_APPROVAL', request);
      await rpc(
        'resolve_discount_request',
        {
          p_request: request,
          p_approve: approve,
          p_reason: reason.input.value,
          p_version: quote?.version ?? null,
          p_amount: quote?.amount_cents ?? null,
          p_grant: proof,
          p_key: key,
        },
        z.object({ id: z.uuid(), status: z.string() }),
      );
      editor.close();
      toast(approve ? 'Riduzione autorizzata e applicata.' : 'Richiesta rifiutata.');
      context.navigate(`/conti/${account.id}`);
    }),
  );
}
