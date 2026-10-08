import { z } from 'zod';
import { rpc } from '../api/client';
import { providerPaymentDialog } from './provider-payments';
import { stepUp } from '../auth/step-up';
import { button, dialog, el, field, status, toast } from '../components/dom';
import { formatMoney, parseMoney } from '../services/money';
import { permittedPaymentMethod } from '../services/commercial-scope';
import { paymentRegisterSchema } from '../types/accounts';
import type { Account, AccountBalance } from '../types/accounts';
import { command } from './staff-context';
import type { StaffContext } from './staff-context';

const refundSchema = z.object({
  id: z.uuid(),
  amount_cents: z.number().int(),
  tip_cents: z.number().int(),
  status: z.string(),
  reason: z.string(),
  created_at: z.string(),
});
const paymentSchema = z.object({
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
  refunds: z.array(refundSchema),
});
type Payment = z.infer<typeof paymentSchema>;
const manual = (method: string) => ['CASH', 'CARD_POS', 'SATISPAY_POS'].includes(method);

export function accountClosureActions(
  context: StaffContext,
  account: Account,
  balance: AccountBalance,
): HTMLElement {
  const actions = el('div', { class: 'row' });
  if (account.status !== 'CLOSED') {
    const close = button(
      'Chiudi conto',
      async () => {
        await command('close_account', { p_account: account.id });
        toast('Conto chiuso.');
        context.navigate('/conti');
      },
      'secondary',
    );
    close.disabled = balance.remaining_cents !== 0 || balance.pending_cents !== 0;
    if (close.disabled)
      close.title = 'Il saldo deve essere zero e tutti i pagamenti devono avere un esito.';
    actions.append(close);
  }
  if (
    context.profile.role === 'ADMIN' &&
    (account.status === 'CLOSED' || balance.remaining_cents !== 0)
  ) {
    const reopening = account.status === 'CLOSED';
    const sensitive = button(
      reopening ? 'Riapri conto' : 'Forza chiusura',
      () => {
        const reason = field('Motivo', 'reason');
        reason.input.required = true;
        reason.input.minLength = 8;
        reason.input.maxLength = 2000;
        const key = crypto.randomUUID();
        const editor = dialog(
          reopening ? 'Riapertura contabile' : 'Conferma chiusura forzata',
          el(
            'p',
            {},
            reopening
              ? 'Il conto torna disponibile in Cassa. Il codice cliente e lo stato attuale del tavolo restano separati da questa correzione.'
              : `Il residuo di ${formatMoney(balance.remaining_cents)} resterà registrato nello storico del conto chiuso.`,
          ),
          reason.root,
        );
        editor.append(
          button(reopening ? 'Conferma riapertura' : 'Conferma chiusura forzata', async () => {
            if (!reason.input.reportValidity()) return;
            const proof = await stepUp(reopening ? 'REOPEN_ACCOUNT' : 'FORCE_CLOSE', account.id);
            await command(reopening ? 'reopen_account' : 'force_close_account', {
              p_account: account.id,
              p_reason: reason.input.value,
              p_step_up: proof,
              p_key: key,
            });
            editor.close();
            toast(reopening ? 'Conto riaperto.' : 'Conto chiuso con autorizzazione.');
            context.navigate(`/conti/${account.id}`);
          }),
        );
      },
      'secondary',
    );
    if (!reopening && balance.pending_cents !== 0) sensitive.disabled = true;
    actions.append(sensitive);
  }
  return actions;
}

export async function accountPaymentHistory(
  context: StaffContext,
  account: Account,
): Promise<HTMLElement> {
  const rows = el('div', { class: 'stack' }),
    view = el('section', { class: 'stack' }, el('h2', {}, 'Pagamenti e rettifiche'), rows);
  let cursor: { id: string; at: string } | null = null;
  const more = button('Carica pagamenti precedenti', load, 'secondary');
  view.append(more);
  async function load(): Promise<void> {
    const data = await rpc(
      'get_account_payments',
      {
        p_account: account.id,
        p_before_at: cursor?.at ?? null,
        p_before_id: cursor?.id ?? null,
        p_limit: 25,
      },
      z.object({ items: z.array(paymentSchema), has_more: z.boolean() }),
    );
    for (const payment of data.items) {
      const card = el(
        'article',
        { class: 'card stack' },
        el(
          'div',
          { class: 'row between' },
          el('h3', {}, formatMoney(payment.amount_cents)),
          status(payment.status),
        ),
        el(
          'p',
          {},
          `${payment.method.replaceAll('_', ' ')} · ${payment.register_name} · ${new Date(payment.created_at).toLocaleString('it-IT')}`,
        ),
        el(
          'p',
          {},
          `Mancia separata ${formatMoney(payment.tip_cents)} · Rimborsi ${formatMoney(payment.refunded_cents)} + ${formatMoney(payment.refunded_tip_cents)} mance`,
        ),
      );
      if (!permittedPaymentMethod(payment.method))
        card.append(
          el('p', { class: 'muted' },
            'Operazione storica con metodo escluso dalla CORE: consultazione consentita; nuove rettifiche e richieste al provider non disponibili.'),
        );
      if (!manual(payment.method) && payment.status === 'PENDING' && permittedPaymentMethod(payment.method))
        card.append(
          button(
            'Riprendi verifica online',
            () => providerPaymentDialog(context, account.id, payment.id),
            'secondary',
          ),
        );
      if (
        manual(payment.method) &&
        permittedPaymentMethod(payment.method) &&
        ['COMPLETED', 'PENDING'].includes(payment.status) &&
        !payment.refunds.some((item) => !['FAILED', 'REJECTED'].includes(item.status)) &&
        (account.status !== 'CLOSED' || context.profile.role === 'ADMIN')
      ) {
        card.append(
          button(
            'Storna pagamento manuale',
            () => {
              const reason = field('Motivo dello storno', 'reason');
              reason.input.required = true;
              reason.input.minLength = 3;
              reason.input.maxLength = 2000;
              const editor = dialog(
                'Conferma storno manuale',
                el(
                  'p',
                  {},
                  'Usa lo storno per correggere un incasso registrato per errore. Il saldo del conto sarà ricalcolato e il movimento resterà nello storico.',
                ),
                reason.root,
              );
              editor.append(
                button('Conferma storno', async () => {
                  if (!reason.input.reportValidity()) return;
                  const proof =
                    account.status === 'CLOSED' ? await stepUp('CANCEL_PAYMENT', payment.id) : null;
                  await command('cancel_manual_payment', {
                    p_payment: payment.id,
                    p_reason: reason.input.value,
                    p_step_up: proof,
                  });
                  editor.close();
                  toast('Storno registrato.');
                  context.navigate(`/conti/${account.id}`);
                }),
              );
            },
            'secondary',
          ),
        );
      }
      if (
        context.profile.role === 'ADMIN' &&
        permittedPaymentMethod(payment.method) &&
        ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(payment.status) &&
        (payment.amount_cents > payment.refunded_cents ||
          payment.tip_cents > payment.refunded_tip_cents)
      )
        card.append(button('Rimborsa', () => refundDialog(context, account, payment), 'secondary'));
      for (const refund of payment.refunds) {
        if (
          refund.status === 'PENDING' &&
          !manual(payment.method) &&
          permittedPaymentMethod(payment.method) &&
          context.profile.role === 'ADMIN'
        )
          card.append(
            button(
              'Verifica rimborso online',
              () => providerPaymentDialog(context, account.id, payment.id, refund.id),
              'secondary',
            ),
          );
        card.append(
          el(
            'div',
            { class: 'card' },
            el(
              'strong',
              {},
              `Rimborso ${formatMoney(refund.amount_cents)} + ${formatMoney(refund.tip_cents)} mance`,
            ),
            status(refund.status),
            el('p', {}, refund.reason),
            el('p', { class: 'muted' }, new Date(refund.created_at).toLocaleString('it-IT')),
          ),
        );
      }
      rows.append(card);
    }
    const last = data.items.at(-1);
    cursor = last ? { id: last.id, at: last.created_at } : null;
    more.hidden = !data.has_more;
    if (!rows.childElementCount)
      rows.append(el('p', { class: 'muted' }, 'Nessun pagamento registrato.'));
  }
  await load();
  return view;
}

async function refundDialog(
  context: StaffContext,
  account: Account,
  payment: Payment,
): Promise<void> {
  if (!permittedPaymentMethod(payment.method)) {
    dialog(
      'Rimborso non disponibile',
      el('p', {}, 'Questo metodo appartiene a un provider escluso dalla versione CORE. La transazione storica resta visibile ma non può essere rimborsata da questa edizione.'),
    );
    return;
  }
  const registers = await rpc(
    'get_payment_registers',
    { p_venue: account.venue_id },
    z.array(paymentRegisterSchema),
  );
  if (!registers.length) {
    dialog(
      'Apri un servizio di cassa',
      el('p', {}, 'Il rimborso deve essere registrato in un servizio contabile aperto della sede.'),
    );
    return;
  }
  const register = el(
    'select',
    { 'aria-label': 'Cassa del rimborso' },
    ...registers.map((row) => el('option', { value: row.id }, row.name)),
  );
  if (registers.some((row) => row.id === payment.cash_register_id))
    register.value = payment.cash_register_id;
  const amount = field(
    'Importo da rimborsare',
    'amount',
    'text',
    ((payment.amount_cents - payment.refunded_cents) / 100).toFixed(2),
  );
  amount.input.inputMode = 'decimal';
  amount.input.required = true;
  const tip = field(
    'Mancia da rimborsare',
    'tip',
    'text',
    ((payment.tip_cents - payment.refunded_tip_cents) / 100).toFixed(2),
  );
  tip.input.inputMode = 'decimal';
  tip.input.required = true;
  const reason = field('Motivo del rimborso', 'reason');
  reason.input.required = true;
  reason.input.minLength = 3;
  reason.input.maxLength = 2000;
  const confirmed = el('input', { type: 'checkbox' });
  confirmed.required = manual(payment.method);
  const editor = dialog(
    'Rimborso totale o parziale',
    el(
      'p',
      {},
      `Metodo originario: ${payment.method.replaceAll('_', ' ')}. Gli importi del pagamento originale saranno conservati.`,
    ),
    el('label', { class: 'field' }, 'Cassa', register),
    amount.root,
    tip.root,
    reason.root,
    manual(payment.method)
      ? el(
          'label',
          { class: 'checkbox-line' },
          confirmed,
          'Ho verificato la restituzione dell’importo al cliente.',
        )
      : el('p', {}, 'Il rimborso sarà confermato soltanto dopo l’esito del provider.'),
  );
  const key = crypto.randomUUID();
  editor.append(
    button('Autorizza rimborso', async () => {
      if (
        [amount.input, tip.input, reason.input, confirmed].some((input) => !input.reportValidity())
      )
        return;
      const amountCents = Number(parseMoney(amount.input.value)),
        tipCents = Number(parseMoney(tip.input.value));
      if (
        amountCents > payment.amount_cents - payment.refunded_cents ||
        tipCents > payment.tip_cents - payment.refunded_tip_cents ||
        amountCents + tipCents === 0
      ) {
        toast('L’importo supera il residuo rimborsabile o è zero.', true);
        return;
      }
      const proof = await stepUp('REFUND', payment.id);
      const result = await rpc(
        'create_refund',
        {
          p_payment: payment.id,
          p_amount: amountCents,
          p_tip: tipCents,
          p_reason: reason.input.value,
          p_step_up: proof,
          p_key: key,
          p_register: register.value,
        },
        z.object({ id: z.uuid(), status: z.string() }),
      );
      editor.close();
      toast(
        result.status === 'COMPLETED'
          ? 'Rimborso manuale registrato.'
          : 'Rimborso in attesa dell’esito provider.',
      );
      if (!manual(payment.method))
        await providerPaymentDialog(context, account.id, payment.id, result.id);
      else context.navigate(`/conti/${account.id}`);
    }),
  );
}
