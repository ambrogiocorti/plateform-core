import { z } from 'zod';
import { client, safeEdgeError } from '../api/client';
import { button, el } from '../components/dom';
import { pendingDepositAccess } from '../services/deposit-access';
import type { DepositAccess } from '../services/deposit-access';
import { depositNextAction } from '../services/public-booking-contract';
import type { Venue } from '../types/domain';

const statusSchema = z.object({
  deposit_id: z.uuid(),
  outcome: z.enum([
    'CONFIRMED',
    'PENDING',
    'FAILED',
    'EXPIRED',
    'CANCELLED',
    'NO_SHOW',
    'RECONCILIATION_REQUIRED',
  ]),
  amount_cents: z.number().int().positive(),
  currency: z.literal('EUR'),
  provider: z.enum(['STRIPE', 'SATISPAY']).nullable(),
  providers: z.array(z.enum(['STRIPE', 'SATISPAY'])),
  service_date: z.string().nullable(),
  slot_time: z.string().nullable(),
  party_size: z.number().int().nullable(),
});
const checkoutSchema = z.object({
  deposit_id: z.uuid(),
  provider: z.enum(['STRIPE', 'SATISPAY']),
  state: z.enum(['WAITING', 'COMPLETED', 'FAILED']),
  checkout_url: z.string().nullable(),
});

export async function publicDepositPage(
  venue: Venue,
  deposit: string,
  inMemoryAccess?: DepositAccess,
): Promise<HTMLElement> {
  const view = el('section', { class: 'card stack', 'aria-live': 'polite' });
  const contact = () =>
    el('a', { href: `tel:${venue.phone.replace(/[^+0-9]/g, '')}` }, `Chiama ${venue.name}`);
  const access = inMemoryAccess ?? pendingDepositAccess(sessionStorage, deposit, venue.id);
  if (!access) {
    view.append(
      el('h2', {}, 'Verifica la prenotazione con il ristorante'),
      el(
        'p',
        {},
        'Questo dispositivo non dispone più dell’accesso alla verifica del pagamento. Non ripetere la prenotazione.',
      ),
      contact(),
    );
    return view;
  }
  let busy = false;
  async function invoke(body: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client().functions.invoke('reservation-deposit', { body });
    if (error) throw await safeEdgeError(error);
    return data;
  }
  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    view.replaceChildren(
      el('p', { role: 'status' }, 'Verifica del pagamento e della prenotazione…'),
    );
    try {
      const data = statusSchema.parse(
        await invoke({ action: 'status', deposit_id: deposit, access_token: access!.token }),
      );
      if (data.deposit_id !== deposit) throw new Error('DEPOSIT_MISMATCH');
      const titles = {
        CONFIRMED: 'Prenotazione confermata',
        PENDING: 'Pagamento in attesa di conferma',
        FAILED: 'Pagamento non riuscito',
        EXPIRED: 'Prenotazione scaduta',
        CANCELLED: 'Prenotazione annullata',
        NO_SHOW: 'Prenotazione non usufruita',
        RECONCILIATION_REQUIRED: 'Pagamento da verificare con il ristorante',
      };
      view.replaceChildren(el('h2', {}, titles[data.outcome]));
      if (data.outcome === 'CONFIRMED') {
        view.append(
          el(
            'p',
            {},
            `${data.party_size ?? ''} persone · ${data.service_date ?? ''} ${data.slot_time ?? ''}`,
          ),
        );
      } else {
        view.append(
          el('p', {}, 'Non inviare una nuova prenotazione prima di aver verificato questo esito.'),
        );
      }
      view.append(
        el(
          'p',
          {},
          `Garanzia prenotazione: ${(data.amount_cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })}.`,
        ),
      );
      if (data.outcome === 'PENDING') {
        view.append(button('Aggiorna esito', refresh, 'secondary'));
        for (const provider of data.provider ? [data.provider] : data.providers) {
          const requestKey = crypto.randomUUID();
          view.append(
            button(
              `Riprendi pagamento con ${provider === 'STRIPE' ? 'Stripe' : 'Satispay'}`,
              async () => {
                if (busy) return;
                busy = true;
                try {
                  const checkout = checkoutSchema.parse(
                    await invoke({
                      action: 'start',
                      deposit_id: deposit,
                      access_token: access!.token,
                      provider,
                      idempotency_key: requestKey,
                    }),
                  );
                  const next = depositNextAction(checkout, deposit, provider);
                  if (next.action === 'REDIRECT') window.location.assign(next.url);
                  else {
                    busy = false;
                    await refresh();
                  }
                } catch (error) {
                  view.replaceChildren(
                    el('p', { role: 'alert' }, (await safeEdgeError(error)).message),
                    button('Verifica esito', refresh, 'secondary'),
                    contact(),
                  );
                } finally {
                  busy = false;
                }
              },
              'secondary',
            ),
          );
        }
      }
      view.append(contact());
    } catch (error) {
      view.replaceChildren(
        el('h2', {}, 'Esito non ancora verificato'),
        el('p', { role: 'alert' }, (await safeEdgeError(error)).message),
        button('Verifica esito', refresh, 'secondary'),
        contact(),
      );
    } finally {
      busy = false;
    }
  }
  await refresh();
  return view;
}
