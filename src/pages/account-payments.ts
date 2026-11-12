import { z } from 'zod';
import { rpc } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import { formatMoney, parseMoney } from '../services/money';
import { providerPaymentDialog } from './provider-payments';
import { paymentRegisterSchema } from '../types/accounts';
import { permittedPaymentMethod, permittedPaymentMethods } from '../services/commercial-scope';
import type { StaffContext } from './staff-context';

export async function paymentDialog(
  context: StaffContext,
  account: string,
  remaining: number,
  items: { item_id: string; quantity: number }[] = [],
  share?: string,
  onComplete?: () => void | Promise<void>,
): Promise<void> {
  const registers = await rpc(
    'get_payment_registers',
    { p_venue: context.venue?.id },
    z.array(paymentRegisterSchema),
  );
  if (!registers.length) {
    dialog(
      'Apri un servizio di cassa',
      el(
        'p',
        {},
        'Per incassare seleziona una cassa assegnata con postazione e servizio contabile aperti.',
      ),
    );
    return;
  }
  const register = el(
    'select',
    { 'aria-label': 'Cassa' },
    ...registers.map((row) => el('option', { value: row.id }, `${row.name} · ${row.status}`)),
  );
  const amount = field('Importo del conto', 'amount', 'text', (remaining / 100).toFixed(2));
  amount.input.inputMode = 'decimal';
  amount.input.readOnly = items.length > 0 || !!share;
  const tip = field('Mancia separata', 'tip', 'text', '0,00');
  tip.input.inputMode = 'decimal';
  const method = el('select', { 'aria-label': 'Metodo di pagamento' });
  const paymentMethodNotice = el('p', { class: 'muted', role: 'status' });
  const updateMethods = () => {
    const allowed = permittedPaymentMethods(
      registers.find((row) => row.id === register.value)?.payment_methods ?? [],
    );
    method.replaceChildren(
      ...allowed.map((value) =>
        el(
          'option',
          { value },
          (
            {
              CASH: 'Contanti',
              CARD_POS: 'POS carta',
              SATISPAY_POS: 'POS Satispay',
              STRIPE: 'Carta online',
              SATISPAY_API: 'Satispay online',
            } as Record<string, string>
          )[value] ?? value,
        ),
      ),
    );
    method.disabled = allowed.length === 0;
    paymentMethodNotice.textContent = allowed.length
      ? ''
      : 'Questa cassa non ha metodi utilizzabili nell’edizione CORE: abilita Contanti o POS esterno nelle impostazioni.';
  };
  register.addEventListener('change', updateMethods);
  updateMethods();
  const key = crypto.randomUUID();
  const editor = dialog(
    'Registra un pagamento',
    el('label', {}, 'Cassa', register),
    amount.root,
    tip.root,
    el('label', {}, 'Metodo', method),
    paymentMethodNotice,
  );
  editor.append(
    button('Prepara pagamento', async () => {
      if (!permittedPaymentMethod(method.value)) {
        toast('Configura una cassa con contanti o POS esterno per effettuare l’incasso.', true);
        return;
      }
      const result = await rpc(
        'create_payment',
        {
          p_account: account,
          p_register: register.value,
          p_amount: Number(parseMoney(amount.input.value)),
          p_tip: Number(parseMoney(tip.input.value)),
          p_method: method.value,
          p_key: key,
          p_items: items,
          ...(share ? { p_share: share } : {}),
        },
        z.object({ id: z.uuid(), status: z.string() }),
      );
      editor.close();
      if (['STRIPE', 'SATISPAY_API'].includes(method.value)) {
        await providerPaymentDialog(context, account, result.id, undefined, onComplete);
        return;
      }
      const confirm = dialog(
        'Conferma l’incasso',
        el(
          'p',
          {},
          'Completa l’incasso in contanti o sul POS esterno. Conferma soltanto dopo aver verificato l’esito.',
        ),
        el(
          'p',
          { class: 'amount' },
          formatMoney(parseMoney(amount.input.value) + parseMoney(tip.input.value)),
        ),
      );
      confirm.append(
        button('Incasso verificato', async () => {
          await rpc(
            'confirm_manual_payment',
            { p_payment: result.id, p_success: true },
            z.object({ id: z.uuid(), status: z.string() }),
          );
          confirm.close();
          toast('Pagamento registrato.');
          if (onComplete) await onComplete();
          else context.navigate(`/conti/${account}`);
        }),
        button(
          'Pagamento non riuscito',
          async () => {
            await rpc(
              'confirm_manual_payment',
              { p_payment: result.id, p_success: false },
              z.object({ id: z.uuid(), status: z.string() }),
            );
            confirm.close();
            if (onComplete) await onComplete();
            else context.navigate(`/conti/${account}`);
          },
          'secondary',
        ),
      );
    }),
  );
}
