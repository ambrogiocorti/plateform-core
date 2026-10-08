import { bookingField } from '../components/booking-fields';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApplicationError, client, rpc, safeError } from '../api/client';
import { button, el, emptyState, field } from '../components/dom';
import type { Venue } from '../types/domain';
import { addCalendarDays, bookableSlots, depositNextAction, venueLocalToday } from '../services/public-booking-contract';
import type { SearchKey } from '../services/public-booking-contract';
import { externalPaymentProvidersIncluded, permittedBookingSlots, requiresExcludedDeposit } from '../services/commercial-scope';

async function bookingFailure(error: unknown): Promise<never> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = z.object({ code: z.string(), request_id: z.string().optional() }).parse(await error.context.json());
      const parsed = safeError({ message: payload.code }, payload.request_id ?? crypto.randomUUID());
      if (parsed.code !== 'REQUEST_FAILED') throw parsed;
    } catch (parsed) {
      if (parsed instanceof ApplicationError) throw parsed;
    }
  }
  throw error;
}

const bookingSchema = z.object({
  services: z.array(z.object({
    id: z.uuid(), name: z.string(), starts_at: z.string(), ends_at: z.string(),
    weekdays: z.array(z.number()), slot_interval_minutes: z.number(),
  })),
  fields: z.array(z.object({
    id: z.uuid(), key: z.string(), type: z.string(), label: z.string(),
    placeholder: z.string().nullable(), required: z.boolean(), options: z.array(z.string()),
  })),
});

const slotSchema = z.object({
  time: z.string(), available: z.boolean(), reason: z.string().optional(),
  status_if_booked: z.enum(['RESERVED','REQUESTED','PENDING_DEPOSIT']).optional(),
  deposit: z.object({ amount_cents: z.number(), currency: z.string(), expiry_minutes: z.number() }).optional(),
});
const availabilitySchema = z.object({
  venue_id: z.uuid(), service_id: z.uuid(), date: z.iso.date(),
  party_size: z.number().int(), slots: z.array(slotSchema),
});
const bookingResult = z.discriminatedUnion('status', [
  z.object({ id: z.uuid(), status: z.enum(['RESERVED', 'REQUESTED']) }),
  z.object({ id: z.uuid(), status: z.literal('PENDING_DEPOSIT'), deposit: z.object({
    id: z.uuid(), amount_cents: z.number().int().positive(), currency: z.literal('EUR'),
    expires_at: z.iso.datetime({ offset: true }), access_token: z.string().min(32),
  }) }),
]);
const checkoutResult = z.object({ deposit_id: z.uuid(), provider: z.enum(['STRIPE','SATISPAY']),
  state: z.enum(['WAITING', 'COMPLETED', 'FAILED']), checkout_url: z.string().nullable(),
});

/** A public booking is online-only; a lost response is never presented as success. */
export async function bookingPage(venue: Venue, privacyUrl?: string): Promise<HTMLElement> {
  if (!venue.reservations_enabled || !privacyUrl || !privacyUrl.startsWith('https://'))
    return emptyState('Prenotazioni online non disponibili', 'Contatta il ristorante per prenotare.');

  const configuration = await rpc('get_booking_configuration', { p_venue: venue.id }, bookingSchema.nullable());
  if (!configuration?.services.length) return emptyState('Prenotazioni non disponibili', 'Contatta il ristorante per verificare le disponibilità.');

  const form = el('section', { class: 'booking-form card' });
  const first = field('Nome', 'first');
  const last = field('Cognome', 'last');
  const phone = field('Telefono con prefisso internazionale', 'phone', 'tel');
  phone.input.placeholder = '+39';
  phone.input.pattern = '\\+[0-9]{7,15}';
  const party = field('Persone', 'party', 'number', '2');
  party.input.min = '1'; party.input.max = '1000'; party.input.step = '1';
  const date = field('Data', 'date', 'date');
  date.input.min = venueLocalToday(venue.timezone);
  date.input.max = addCalendarDays(date.input.min, 180);
  for (const input of [first, last, phone, party, date]) input.input.required = true;
  const service = el('select', { 'aria-label': 'Servizio' },
    ...configuration.services.map((entry) => el('option', { value: entry.id }, entry.name)));
  const time = el('select', { 'aria-label': 'Orario' });
  time.required = true;
  const status = el('p', { role: 'status', 'aria-live': 'polite', class: 'muted' });
  let sequence = 0;
  let verifiedKey: SearchKey | undefined;
  let submitted = false;
  let locked = false;
  const resetTime = () => {
    sequence++;
    verifiedKey = undefined;
    time.disabled = true;
    time.replaceChildren(el('option', { value: '' }, 'Verifica prima la disponibilità'));
    status.textContent = '';
  };
  resetTime();
  const checkAvailability = button('Verifica disponibilità', async () => {
    resetTime();
    if (![party, date].every((entry) => entry.input.reportValidity())) return;
    if (date.input.value < date.input.min || date.input.value > date.input.max) return;
    const token = sequence;
    const key: SearchKey = { venueId: venue.id, serviceId: service.value,
      date: date.input.value, party: Number(party.input.value) };
    status.textContent = 'Verifica disponibilità in corso…';
    const result = await rpc('get_public_booking_availability', {
      p_venue: key.venueId, p_service: key.serviceId, p_date: key.date, p_party: key.party,
    }, availabilitySchema);
    if (token !== sequence || !form.isConnected) return;
    // In the core-only edition, never offer a time slot that requires an
    // unavailable online deposit provider. The authoritative server may have
    // stricter rules than the public UI last observed.
    const confirmedSlots = bookableSlots(result, key);
    const slots = permittedBookingSlots(confirmedSlots);
    if (!slots.length) {
      status.textContent = confirmedSlots.some(requiresExcludedDeposit)
        ? 'Gli orari disponibili richiedono una caparra online non gestita in questa edizione. Contatta il ristorante.'
        : 'Non ci sono orari disponibili per questa richiesta.';
      return;
    }
    verifiedKey = key;
    time.disabled = false;
    time.replaceChildren(el('option', { value: '' }, 'Seleziona un orario'),
      ...slots.map((slot) => el('option', { value: slot.time }, slot.time)));
    time.value = '';
    status.textContent = `${slots.length} orari disponibili. Selezionane uno per continuare.`;
  }, 'secondary');
  for (const control of [service, date.input, party.input]) control.addEventListener('change', resetTime);
  for (const control of [service, date.input, party.input]) control.addEventListener('input', resetTime);

  form.append(el('h2', {}, `Un tavolo da ${venue.name}`),
    el('p', { class: 'muted' }, 'Le disponibilità sono verificate dal ristorante in tempo reale.'),
    ...[first, last, phone, party, date].map((entry) => entry.root),
    el('div', { class: 'field' }, el('label', {}, 'Servizio', service)),
    checkAvailability,
    el('div', { class: 'field' }, el('label', {}, 'Orario', time)),status);
  const answers = new Map(configuration.fields.map((entry) => [entry.id, bookingField(entry)]));
  for (const input of answers.values()) form.append(input.root);
  const privacyConsent = el('input', { type: 'checkbox', required: '', id: 'booking-privacy-consent' });
  const privacyLink = el('a', { href: privacyUrl, target: '_blank', rel: 'noopener noreferrer' }, 'informativa privacy');
  form.append(el('label', { class: 'field' }, privacyConsent, ' Ho letto l’', privacyLink, ' e autorizzo il trattamento dei dati per la prenotazione.'));
  form.append(el('p', { class: 'muted' }, 'Per modifiche o cancellazioni contatta il ristorante.'));
  const requestKey = crypto.randomUUID();
  const submit = button('Richiedi il tavolo', async () => {
    if (locked || submitted) return;
    if ([first, last, phone, party, date].some((entry) => !entry.input.reportValidity()) ||
        !privacyConsent.reportValidity() || [...answers.values()].some((input) => !input.valid()) ||
        !time.reportValidity()) return;
    const search: SearchKey = { venueId: venue.id, serviceId: service.value,
      date: date.input.value, party: Number(party.input.value) };
    if (!verifiedKey || JSON.stringify(verifiedKey) !== JSON.stringify(search) || !time.value) {
      status.textContent = 'Verifica di nuovo la disponibilità prima di inviare la richiesta.';
      return;
    }
    locked = true;
    const response: Record<string, unknown> = {};
    for (const [id, input] of answers) response[id] = input.value();
    status.textContent = 'Invio della richiesta in corso…';
    try {
      const { data, error } = await client().functions.invoke('reservation', { body: {
        venue_id: venue.id, service_id: search.serviceId, date: search.date, time: time.value,
        first_name: first.input.value, last_name: last.input.value, phone: phone.input.value,
        party_size: search.party, answers: response, idempotency_key: requestKey,
      }});
      if (error) await bookingFailure(error);
      const result = bookingResult.parse(data);
      submitted = true;
      if (result.status === 'PENDING_DEPOSIT') {
        if (!externalPaymentProvidersIncluded) {
          form.replaceChildren(
            el('h2', {}, 'Prenotazione non ancora confermata'),
            el('p', { role: 'alert' }, 'La sede richiede una caparra online non disponibile in questa edizione. Non inviare un’altra richiesta: contatta direttamente il ristorante.'),
            el('a', { href: `tel:${venue.phone.replace(/[^+0-9]/g, '')}` }, venue.phone),
          );
          return;
        }
        form.replaceChildren(el('h2', {}, 'Caparra necessaria per completare la prenotazione'),
          el('p', {}, `Importo: ${(result.deposit.amount_cents / 100).toLocaleString('it-IT',{style:'currency',currency:'EUR'})}. Il tavolo non è ancora confermato.`),
          el('p', { role: 'status' }, 'Il pagamento deve essere confermato dal ristorante dopo la verifica del provider.'));
        let checkoutStarted = false;
        const checkoutStatus = el('p', {role: 'status', 'aria-live': 'polite'});
        for (const provider of ['STRIPE', 'SATISPAY'] as const) {
          form.append(button(`Paga la caparra con ${provider === 'STRIPE' ? 'Stripe' : 'Satispay'}`, async () => {
            if (checkoutStarted) return;
            checkoutStarted = true; // A second provider must not race the first request.
            checkoutStatus.textContent = 'Preparazione del pagamento in corso…';
            try {
              const { data: checkoutData, error: checkoutError } = await client().functions.invoke('reservation-deposit', {
                body: { deposit_id: result.deposit.id, access_token: result.deposit.access_token,
                  provider, idempotency_key: crypto.randomUUID() },
              });
              if (checkoutError) await bookingFailure(checkoutError);
              const checkout = checkoutResult.parse(checkoutData);
              const next = depositNextAction(checkout, result.deposit.id, provider);
              if (next.action === 'AWAIT_CONFIRMATION') {
                checkoutStatus.textContent = 'Pagamento rilevato. La conferma della prenotazione dipende dalla verifica del ristorante.';
              } else if (next.action === 'FAILED') {
                checkoutStatus.textContent = 'Pagamento non riuscito. Contatta il ristorante per verificare la prenotazione.';
              } else if (next.action === 'REDIRECT') {
                window.location.assign(next.url);
              } else {
                checkoutStatus.textContent = 'Il pagamento è in elaborazione. Contatta il ristorante prima di riprovare.';
              }
            } catch (error) {
              checkoutStatus.textContent = 'Impossibile verificare l’avvio del pagamento. Non ripetere la richiesta; contatta il ristorante.';
              throw error;
            }
          }, 'secondary'));
        }
        form.append(checkoutStatus);
      } else {
        form.replaceChildren(el('p', { class: 'eyebrow' }, 'A presto'),
          el('h2', {}, result.status === 'RESERVED' ? 'Il tuo tavolo è prenotato.' : 'Abbiamo ricevuto la richiesta.'),
          el('p', {}, result.status === 'REQUESTED'
            ? 'Il ristorante deve ancora confermare il tuo gruppo.'
            : 'Ti aspettiamo. Per modifiche o cancellazioni, contatta il ristorante.'),
          el('a', { href: `tel:${venue.phone.replace(/[^+0-9]/g, '')}` }, venue.phone));
      }
    } catch (error) {
      // A request may already have committed even if its response was lost: never create a second booking.
      status.textContent = 'Non è possibile verificare l’esito dell’invio. Non ripetere la prenotazione: contatta il ristorante.';
      throw error;
    }
  });
  form.append(submit);
  return form;
}
