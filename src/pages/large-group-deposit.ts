import { z } from 'zod';
import { rpc } from '../api/client';
import { button, el, field, toast } from '../components/dom';
import { euro } from '../services/public-booking-contract';
import type { StaffContext } from './staff-context';

// Large-group booking deposit (owner decision 2026-10-21): the venue admin sets, per service, from
// how many people a guarantee is asked and how much. The server decides when it applies and
// refuses it without the BOOKING_DEPOSITS licence and a licensed provider offered by the venue.
const settingsSchema = z.object({
  licensed: z.boolean(),
  venue_enabled: z.boolean(),
  providers: z.array(z.enum(['STRIPE', 'SATISPAY'])),
  ready: z.boolean(),
  services: z.array(
    z.object({
      service_id: z.uuid(),
      name: z.string(),
      version: z.number(),
      enabled: z.boolean(),
      deposit_policy: z.string(),
      min_party_size: z.number().int().nullable(),
      amount_cents: z.number().int().nullable(),
      cancel_refund_hours: z.number().int(),
      max_party_size_auto_confirm: z.number().int(),
    }),
  ),
});

const providerLabel = (provider: 'STRIPE' | 'SATISPAY') =>
  provider === 'STRIPE' ? 'Stripe' : 'Satispay';

export async function largeGroupDepositSection(context: StaffContext): Promise<HTMLElement> {
  const section = el(
    'section',
    { class: 'card stack', 'aria-labelledby': 'large-group-deposit-title' },
    el('h2', { id: 'large-group-deposit-title' }, 'Caparra per gruppi numerosi'),
    el(
      'p',
      {},
      'Una garanzia, non un anticipo sul conto: viene restituita automaticamente quando il gruppo si presenta o cancella in tempo, ed è trattenuta solo se il gruppo non si presenta. I gruppi più piccoli prenotano come sempre.',
    ),
  );
  const venue = context.venue?.id;
  if (!venue) return section;
  const settings = await rpc(
    'get_large_group_deposit_settings',
    { p_venue: venue },
    settingsSchema,
  );
  if (!settings.licensed) {
    section.append(
      el(
        'p',
        { role: 'note' },
        'La caparra online non è attiva su questa installazione: serve la licenza “Caparre prenotazioni” insieme a quella di Stripe o Satispay (Super Admin).',
      ),
    );
    return section;
  }
  section.append(
    el(
      'p',
      { class: 'muted' },
      settings.providers.length
        ? `Pagamento con ${settings.providers.map(providerLabel).join(' o ')}.`
        : 'Nessun pagamento online disponibile per la sede: aggiungi Stripe o Satispay ai metodi di pagamento della sede (Impostazioni) per poter chiedere la caparra.',
    ),
  );
  for (const service of settings.services) {
    const form = el('form', { class: 'stack', 'aria-label': `Caparra · ${service.name}` });
    const enabled = el('input', { type: 'checkbox', id: `deposit-on-${service.service_id}` });
    enabled.checked = service.enabled;
    enabled.disabled = !settings.providers.length && !service.enabled;
    const threshold = field(
      'Da quante persone si chiede la caparra',
      `deposit-party-${service.service_id}`,
      'number',
      String(service.min_party_size ?? Math.min(8, service.max_party_size_auto_confirm)),
    );
    threshold.input.min = '2';
    threshold.input.max = String(service.max_party_size_auto_confirm);
    threshold.input.step = '1';
    const amount = field(
      'Importo della caparra in euro',
      `deposit-amount-${service.service_id}`,
      'number',
      service.amount_cents ? String(service.amount_cents / 100) : '20',
    );
    amount.input.min = '1';
    amount.input.max = '1000';
    amount.input.step = '0.01';
    const hours = field(
      'Rimborso automatico se cancellano almeno … ore prima',
      `deposit-hours-${service.service_id}`,
      'number',
      String(service.cancel_refund_hours),
    );
    hours.input.min = '0';
    hours.input.max = '720';
    hours.input.step = '1';
    const help = el(
      'p',
      { class: 'muted', id: `deposit-help-${service.service_id}` },
      `I gruppi oltre ${service.max_party_size_auto_confirm} persone restano richieste da approvare (Capacità): la soglia non può superare questo limite. Una cancellazione più tardiva arriva all’Admin, che decide se rimborsare.`,
    );
    threshold.input.setAttribute('aria-describedby', help.id);
    const state = el(
      'p',
      { role: 'status', 'aria-live': 'polite' },
      service.enabled && service.min_party_size && service.amount_cents
        ? `Attiva: ${euro(service.amount_cents)} da ${service.min_party_size} persone.`
        : service.deposit_policy !== 'DISABLED' && !service.enabled
          ? 'È configurata una regola di caparra diversa: salvando la sostituisci.'
          : 'Non attiva.',
    );
    const syncDisabled = () => {
      for (const input of [threshold.input, amount.input]) {
        input.disabled = !enabled.checked;
        input.required = enabled.checked;
      }
    };
    enabled.addEventListener('change', syncDisabled);
    syncDisabled();
    let key = crypto.randomUUID();
    let version = service.version;
    form.append(
      el('h3', {}, service.name),
      el('label', { for: enabled.id }, enabled, ' Chiedi la caparra ai gruppi numerosi'),
      threshold.root,
      amount.root,
      hours.root,
      help,
      button(`Salva caparra · ${service.name}`, async () => {
        if (![threshold.input, amount.input, hours.input].every((i) => i.reportValidity())) return;
        const result = await rpc(
          'configure_large_group_deposit',
          {
            p_venue: venue,
            p_service: service.service_id,
            p_version: version,
            p_enabled: enabled.checked,
            p_min_party_size: enabled.checked ? Number(threshold.input.value) : null,
            p_amount_cents: enabled.checked ? Math.round(Number(amount.input.value) * 100) : null,
            p_cancel_refund_hours: Number(hours.input.value),
            p_key: key,
          },
          z.object({
            version: z.number(),
            enabled: z.boolean(),
            min_party_size: z.number().nullable(),
            amount_cents: z.number().nullable(),
          }),
        );
        key = crypto.randomUUID();
        version = result.version;
        state.textContent =
          result.enabled && result.amount_cents && result.min_party_size
            ? `Attiva: ${euro(result.amount_cents)} da ${result.min_party_size} persone.`
            : 'Non attiva.';
        toast('Caparra per gruppi numerosi salvata.');
      }),
      state,
    );
    form.addEventListener('submit', (event) => event.preventDefault());
    section.append(form);
  }
  return section;
}
