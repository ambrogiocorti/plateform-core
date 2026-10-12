import { z } from 'zod';
import { rpc } from '../api/client';
import { button, dialog, el, toast } from '../components/dom';
import { permittedPaymentMethod } from '../services/commercial-scope';
import { formatMoney } from '../services/money';

export interface ManualPendingPayment {
  id: string;
  method: string;
  status: string;
  amount_cents: number;
  tip_cents: number;
  register_name: string;
}

export function mayResolveManualPayment(payment: ManualPendingPayment): boolean {
  return (
    payment.status === 'PENDING' &&
    ['CASH', 'CARD_POS', 'SATISPAY_POS'].includes(payment.method) &&
    permittedPaymentMethod(payment.method)
  );
}

/**
 * Recover a previously CREATED payment without starting a second payment.
 * An unknown terminal result must stay PENDING until staff checks the
 * external cash/POS outcome. Server permission and register assignment
 * checks still apply to every confirmation.
 */
export function resolveManualPayment(
  payment: ManualPendingPayment,
  onComplete: () => Promise<void> | void,
): void {
  if (!mayResolveManualPayment(payment)) return;
  const editor = dialog(
    'Verifica pagamento in attesa',
    el(
      'p',
      {},
      'Questa operazione è già stata creata: non ripetere il pagamento. Controlla la ricevuta POS o il contante prima di registrare l’esito.',
    ),
    el('p', {}, `Metodo: ${payment.method.replaceAll('_', ' ')} · Cassa: ${payment.register_name}`),
    el(
      'p',
      { class: 'amount' },
      formatMoney(payment.amount_cents + payment.tip_cents),
    ),
    el(
      'p',
      { class: 'muted' },
      'Se non conosci ancora l’esito, chiudi la finestra: il pagamento rimarrà IN ATTESA. Non dichiararlo non riuscito senza una verifica.',
    ),
  );
  const resultSchema = z.object({ id: z.uuid(), status: z.string() });

  async function conclude(success: boolean): Promise<void> {
    const result = await rpc(
      'confirm_manual_payment',
      { p_payment: payment.id, p_success: success },
      resultSchema,
    );
    editor.close();
    toast(
      result.status === 'COMPLETED'
        ? 'Incasso verificato e registrato.'
        : result.status === 'FAILED'
          ? 'Pagamento non riuscito registrato.'
          : `Il pagamento risulta ${result.status}. Controlla lo storico prima di procedere.`,
    );
    await onComplete();
  }

  editor.append(
    button('Incasso verificato', () => conclude(true)),
    button('Pagamento sicuramente non riuscito', () => conclude(false), 'secondary'),
  );
}
