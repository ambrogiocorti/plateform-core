import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import QRCode from 'qrcode';
import { ApplicationError, client, safeError } from '../api/client';
import { button, dialog, el, status, toast } from '../components/dom';
import type { StaffContext } from './staff-context';
const resultSchema = z.object({
  id: z.uuid(),
  state: z.enum(['NEW', 'IN_FLIGHT', 'WAITING', 'COMPLETED', 'FAILED']),
  checkout_url: z.string().nullable().optional(),
});
const edgeFailureSchema = z.object({ code: z.string(), request_id: z.string().optional() });
async function providerFailure(error: unknown): Promise<ApplicationError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const parsed = edgeFailureSchema.parse(await error.context.json());
      return safeError(new Error(parsed.code), parsed.request_id);
    } catch {
      return safeError(error);
    }
  }
  return safeError(error);
}
export async function providerPaymentDialog(
  context: StaffContext,
  account: string,
  payment: string,
  refund?: string,
  onReturn?: () => void | Promise<void>,
): Promise<void> {
  const content = el('div', { class: 'stack', 'aria-live': 'polite' });
  const popup = dialog(refund ? 'Esito rimborso online' : 'Pagamento online', content);
  async function reconcile(): Promise<void> {
    content.replaceChildren(el('p', {}, 'Verifica del pagamento in corso…'));
    try {
      const { data, error } = await client().functions.invoke('payments', {
        body: { payment_id: payment, refund_id: refund ?? null },
      });
      if (error) throw await providerFailure(error);
      const result = resultSchema.parse(data);
      content.replaceChildren(status(result.state));
      if (result.state === 'COMPLETED' || result.state === 'FAILED') {
        content.append(
          el(
            'p',
            {},
            result.state === 'COMPLETED'
              ? 'Esito confermato dal gestore del pagamento.'
              : 'Il gestore ha confermato che l’operazione non è riuscita.',
          ),
        );
        await context.refresh?.();
      } else {
        content.append(
          el(
            'p',
            {},
            'L’importo resta riservato fino alla verifica dell’esito. Puoi chiudere questa finestra e riprendere dallo storico pagamenti.',
          ),
        );
        if (result.checkout_url && !refund) {
          const url = new URL(result.checkout_url);
          if (
            url.protocol !== 'https:' ||
            !['checkout.stripe.com', 'online.satispay.com', 'staging-online.satispay.com'].includes(
              url.hostname,
            ) ||
            url.port ||
            url.username ||
            url.password
          )
            throw new Error('INVALID_PROVIDER_URL');
          content.append(
            el('img', {
              src: await QRCode.toDataURL(url.href, { errorCorrectionLevel: 'M', width: 256 }),
              alt: 'QR del pagamento',
            }),
            el(
              'a',
              {
                href: url.href,
                target: '_blank',
                rel: 'noopener noreferrer',
                class: 'button secondary',
              },
              'Apri pagamento',
            ),
          );
        }
      }
    } catch (error) {
      content.replaceChildren(
        el(
          'p',
          { role: 'alert' },
          'Esito non ancora verificato. Riprendi la verifica usando lo stesso pagamento.',
        ),
      );
      toast((await providerFailure(error)).message, true);
    }
  }
  popup.append(
    button('Verifica esito', reconcile, 'secondary'),
    button(
      'Torna al conto',
      async () => {
        popup.close();
        if (onReturn) await onReturn();
        else context.navigate(`/conti/${account}`);
      },
      'secondary',
    ),
  );
  await reconcile();
}
