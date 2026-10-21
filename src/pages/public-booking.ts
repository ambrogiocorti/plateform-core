import { bookingField } from '../components/booking-fields';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApplicationError, client, rpc, safeError } from '../api/client';
import { button, el, emptyState, field } from '../components/dom';
import type { Venue } from '../types/domain';
import {
  addCalendarDays,
  bookableSlots,
  depositNextAction,
  depositNotice,
  depositOutcomeView,
  depositReturnId,
  depositTokenKey,
  euro,
  venueLocalToday,
} from '../services/public-booking-contract';
import type { PublicSlot, SearchKey } from '../services/public-booking-contract';
import {
  onlineBookingDepositsIncluded,
  permittedBookingSlots,
  requiresExcludedDeposit,
} from '../services/commercial-scope';

async function bookingFailure(error: unknown): Promise<never> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = z
        .object({ code: z.string(), request_id: z.string().optional() })
        .parse(await error.context.json());
      const parsed = safeError(
        { message: payload.code },
        payload.request_id ?? crypto.randomUUID(),
      );
      if (parsed.code !== 'REQUEST_FAILED') throw parsed;
    } catch (parsed) {
      if (parsed instanceof ApplicationError) throw parsed;
    }
  }
  throw error;
}

const bookingSchema = z.object({
  services: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      starts_at: z.string(),
      ends_at: z.string(),
      weekdays: z.array(z.number()),
      slot_interval_minutes: z.number(),
    }),
  ),
  fields: z.array(
    z.object({
      id: z.uuid(),
      key: z.string(),
      type: z.string(),
      label: z.string(),
      placeholder: z.string().nullable(),
      required: z.boolean(),
      options: z.array(z.string()),
    }),
  ),
});

const slotSchema = z.object({
  time: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
  status_if_booked: z.enum(['RESERVED', 'REQUESTED', 'PENDING_DEPOSIT']).optional(),
  deposit: z
    .object({
      amount_cents: z.number(),
      currency: z.string(),
      expiry_minutes: z.number(),
      providers: z.array(z.enum(['STRIPE', 'SATISPAY'])).optional(),
    })
    .optional(),
});
const availabilitySchema = z.object({
  venue_id: z.uuid(),
  service_id: z.uuid(),
  date: z.iso.date(),
  party_size: z.number().int(),
  slots: z.array(slotSchema),
});
const bookingResult = z.discriminatedUnion('status', [
  z.object({ id: z.uuid(), status: z.enum(['RESERVED', 'REQUESTED']) }),
  z.object({
    id: z.uuid(),
    status: z.literal('PENDING_DEPOSIT'),
    deposit: z.object({
      id: z.uuid(),
      amount_cents: z.number().int().positive(),
      currency: z.literal('EUR'),
      expires_at: z.iso.datetime({ offset: true }),
      access_token: z.string().min(32),
      providers: z.array(z.enum(['STRIPE', 'SATISPAY'])).default([]),
    }),
  }),
]);
const checkoutResult = z.object({
  deposit_id: z.uuid(),
  provider: z.enum(['STRIPE', 'SATISPAY']),
  state: z.enum(['WAITING', 'COMPLETED', 'FAILED']),
  checkout_url: z.string().nullable(),
});

const depositStatusSchema = z.object({
  deposit_id: z.uuid(),
  outcome: z.enum(['CONFIRMED', 'PENDING', 'FAILED', 'EXPIRED', 'RECONCILIATION_REQUIRED']),
  amount_cents: z.number().int().positive(),
  service_date: z.string().nullable(),
  slot_time: z.string().nullable(),
  party_size: z.number().int().nullable(),
});

const providerName = (provider: 'STRIPE' | 'SATISPAY') =>
  provider === 'STRIPE' ? 'carta (Stripe)' : 'Satispay';

function phoneLink(venue: Venue): HTMLElement {
  return el('a', { href: `tel:${venue.phone.replace(/[^+0-9]/g, '')}` }, venue.phone);
}

function readDepositToken(depositId: string): string | null {
  try {
    return sessionStorage.getItem(depositTokenKey(depositId));
  } catch {
    return null;
  }
}

/** Back from Stripe/Satispay: only the server's verified outcome is shown, never the redirect. */
async function depositReturnPage(venue: Venue, depositId: string): Promise<HTMLElement> {
  const view = el('section', { class: 'booking-form card', 'aria-labelledby': 'deposit-outcome' });
  const token = readDepositToken(depositId);
  if (!token) {
    view.append(
      el('h2', { id: 'deposit-outcome' }, 'Stato del pagamento non disponibile qui'),
      el(
        'p',
        {},
        'Questo browser non conserva i dati della richiesta. Contatta il ristorante per conoscere lo stato della prenotazione; non inviarne un’altra.',
      ),
      phoneLink(venue),
    );
    return view;
  }
  const title = el('h2', { id: 'deposit-outcome' }, 'Verifica del pagamento in corso…');
  const body = el('p', { role: 'status', 'aria-live': 'polite' }, '');
  const check = async () => {
    body.textContent = 'Verifica del pagamento con il ristorante in corso…';
    try {
      const { data, error } = await client().functions.invoke('reservation-deposit', {
        body: { action: 'status', deposit_id: depositId, access_token: token },
      });
      if (error) await bookingFailure(error);
      const shown = depositOutcomeView(depositStatusSchema.parse(data), depositId);
      title.textContent = shown.title;
      body.textContent = shown.body;
      refresh.hidden = shown.final;
    } catch (error) {
      title.textContent = 'Impossibile verificare il pagamento';
      body.textContent =
        'Riprova tra poco o contatta il ristorante. Non inviare un’altra prenotazione.';
      refresh.hidden = false;
      throw error;
    }
  };
  const refresh = button('Aggiorna lo stato del pagamento', check, 'secondary');
  view.append(title, body, refresh, phoneLink(venue));
  await check().catch(() => undefined);
  return view;
}

/** A public booking is online-only; a lost response is never presented as success. */
export async function bookingPage(venue: Venue, privacyUrl?: string): Promise<HTMLElement> {
  if (!venue.reservations_enabled || !privacyUrl || !privacyUrl.startsWith('https://'))
    return emptyState(
      'Prenotazioni online non disponibili',
      'Contatta il ristorante per prenotare.',
    );
  const returningDeposit = depositReturnId(window.location.search);
  if (returningDeposit) return await depositReturnPage(venue, returningDeposit);

  const configuration = await rpc(
    'get_booking_configuration',
    { p_venue: venue.id },
    bookingSchema.nullable(),
  );
  if (!configuration?.services.length)
    return emptyState(
      'Prenotazioni non disponibili',
      'Contatta il ristorante per verificare le disponibilità.',
    );

  const form = el('section', { class: 'booking-form card' });
  const first = field('Nome', 'first');
  const last = field('Cognome', 'last');
  const phone = field('Telefono con prefisso internazionale', 'phone', 'tel');
  phone.input.placeholder = '+39';
  phone.input.pattern = '\\+[0-9]{7,15}';
  const party = field('Persone', 'party', 'number', '2');
  party.input.min = '1';
  party.input.max = '1000';
  party.input.step = '1';
  const date = field('Data', 'date', 'date');
  date.input.min = venueLocalToday(venue.timezone);
  date.input.max = addCalendarDays(date.input.min, 180);
  for (const input of [first, last, phone, party, date]) input.input.required = true;
  const service = el(
    'select',
    { 'aria-label': 'Servizio' },
    ...configuration.services.map((entry) => el('option', { value: entry.id }, entry.name)),
  );
  const time = el('select', { 'aria-label': 'Orario' });
  time.required = true;
  const status = el('p', { role: 'status', 'aria-live': 'polite', class: 'muted' });
  // Large groups: the deposit terms of the chosen time, before anything is sent.
  const depositInfo = el('p', { class: 'deposit-terms', id: 'booking-deposit-terms' });
  depositInfo.hidden = true;
  let offered: PublicSlot[] = [];
  const showDepositTerms = () => {
    const chosen = offered.find((slot) => slot.time === time.value);
    depositInfo.hidden = !chosen?.deposit;
    depositInfo.textContent = chosen?.deposit ? depositNotice(chosen.deposit) : '';
    if (chosen?.deposit) time.setAttribute('aria-describedby', depositInfo.id);
    else time.removeAttribute('aria-describedby');
  };
  time.addEventListener('change', showDepositTerms);
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
    offered = [];
    showDepositTerms();
  };
  resetTime();
  const checkAvailability = button(
    'Verifica disponibilità',
    async () => {
      resetTime();
      if (![party, date].every((entry) => entry.input.reportValidity())) return;
      if (date.input.value < date.input.min || date.input.value > date.input.max) return;
      const token = sequence;
      const key: SearchKey = {
        venueId: venue.id,
        serviceId: service.value,
        date: date.input.value,
        party: Number(party.input.value),
      };
      status.textContent = 'Verifica disponibilità in corso…';
      const result = await rpc(
        'get_public_booking_availability',
        {
          p_venue: key.venueId,
          p_service: key.serviceId,
          p_date: key.date,
          p_party: key.party,
        },
        availabilitySchema,
      );
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
      offered = slots;
      time.disabled = false;
      time.replaceChildren(
        el('option', { value: '' }, 'Seleziona un orario'),
        ...slots.map((slot) =>
          el(
            'option',
            { value: slot.time },
            slot.deposit
              ? `${slot.time} · caparra di garanzia ${euro(slot.deposit.amount_cents)}`
              : slot.time,
          ),
        ),
      );
      time.value = '';
      status.textContent = `${slots.length} orari disponibili. Selezionane uno per continuare.`;
      if (slots.some((slot) => slot.deposit))
        status.textContent +=
          ' Per un gruppo di queste dimensioni il ristorante chiede una caparra di garanzia.';
    },
    'secondary',
  );
  for (const control of [service, date.input, party.input])
    control.addEventListener('change', resetTime);
  for (const control of [service, date.input, party.input])
    control.addEventListener('input', resetTime);

  form.append(
    el('h2', {}, `Un tavolo da ${venue.name}`),
    el('p', { class: 'muted' }, 'Le disponibilità sono verificate dal ristorante in tempo reale.'),
    ...[first, last, phone, party, date].map((entry) => entry.root),
    el('div', { class: 'field' }, el('label', {}, 'Servizio', service)),
    checkAvailability,
    el('div', { class: 'field' }, el('label', {}, 'Orario', time)),
    depositInfo,
    status,
  );
  const answers = new Map(configuration.fields.map((entry) => [entry.id, bookingField(entry)]));
  for (const input of answers.values()) form.append(input.root);
  const privacyConsent = el('input', {
    type: 'checkbox',
    required: '',
    id: 'booking-privacy-consent',
  });
  const privacyLink = el(
    'a',
    { href: privacyUrl, target: '_blank', rel: 'noopener noreferrer' },
    'informativa privacy',
  );
  form.append(
    el(
      'label',
      { class: 'field' },
      privacyConsent,
      ' Ho letto l’',
      privacyLink,
      ' e autorizzo il trattamento dei dati per la prenotazione.',
    ),
  );
  form.append(el('p', { class: 'muted' }, 'Per modifiche o cancellazioni contatta il ristorante.'));
  const requestKey = crypto.randomUUID();
  const submit = button('Richiedi il tavolo', async () => {
    if (locked || submitted) return;
    if (
      [first, last, phone, party, date].some((entry) => !entry.input.reportValidity()) ||
      !privacyConsent.reportValidity() ||
      [...answers.values()].some((input) => !input.valid()) ||
      !time.reportValidity()
    )
      return;
    const search: SearchKey = {
      venueId: venue.id,
      serviceId: service.value,
      date: date.input.value,
      party: Number(party.input.value),
    };
    if (!verifiedKey || JSON.stringify(verifiedKey) !== JSON.stringify(search) || !time.value) {
      status.textContent = 'Verifica di nuovo la disponibilità prima di inviare la richiesta.';
      return;
    }
    locked = true;
    const response: Record<string, unknown> = {};
    for (const [id, input] of answers) response[id] = input.value();
    status.textContent = 'Invio della richiesta in corso…';
    try {
      const { data, error } = await client().functions.invoke('reservation', {
        body: {
          venue_id: venue.id,
          service_id: search.serviceId,
          date: search.date,
          time: time.value,
          first_name: first.input.value,
          last_name: last.input.value,
          phone: phone.input.value,
          party_size: search.party,
          answers: response,
          idempotency_key: requestKey,
        },
      });
      if (error) await bookingFailure(error);
      const result = bookingResult.parse(data);
      submitted = true;
      if (result.status === 'PENDING_DEPOSIT') {
        if (!onlineBookingDepositsIncluded) {
          form.replaceChildren(
            el('h2', {}, 'Prenotazione non ancora confermata'),
            el(
              'p',
              { role: 'alert' },
              'La sede richiede una caparra online non disponibile in questa edizione. Non inviare un’altra richiesta: contatta direttamente il ristorante.',
            ),
            el('a', { href: `tel:${venue.phone.replace(/[^+0-9]/g, '')}` }, venue.phone),
          );
          return;
        }
        try {
          sessionStorage.setItem(depositTokenKey(result.deposit.id), result.deposit.access_token);
        } catch {
          // Without session storage the outcome is still settled by the server; the guest is
          // told to call the restaurant on return.
        }
        const deadline = new Date(result.deposit.expires_at).toLocaleTimeString('it-IT', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: venue.timezone,
        });
        form.replaceChildren(
          el('h2', {}, 'Manca solo la caparra di garanzia'),
          el(
            'p',
            {},
            `Per il tuo gruppo il ristorante chiede ${euro(result.deposit.amount_cents)} come garanzia, da pagare entro le ${deadline}. Il tavolo è confermato solo dopo la verifica del pagamento.`,
          ),
          el(
            'p',
            { class: 'muted' },
            'Non è un anticipo sul conto: la caparra ti viene restituita automaticamente quando vi presentate e viene trattenuta solo se non vi presentate. Se cancelli, contatta il ristorante.',
          ),
        );
        let checkoutStarted = false;
        const checkoutStatus = el('p', { role: 'status', 'aria-live': 'polite' });
        if (!result.deposit.providers.length)
          checkoutStatus.textContent =
            'Il pagamento online non è disponibile in questo momento. Contatta il ristorante: non inviare un’altra richiesta.';
        for (const provider of result.deposit.providers) {
          form.append(
            button(
              `Paga la caparra con ${providerName(provider)}`,
              async () => {
                if (checkoutStarted) return;
                checkoutStarted = true; // A second provider must not race the first request.
                checkoutStatus.textContent = 'Preparazione del pagamento in corso…';
                try {
                  const { data: checkoutData, error: checkoutError } =
                    await client().functions.invoke('reservation-deposit', {
                      body: {
                        deposit_id: result.deposit.id,
                        access_token: result.deposit.access_token,
                        provider,
                        idempotency_key: crypto.randomUUID(),
                      },
                    });
                  if (checkoutError) await bookingFailure(checkoutError);
                  const checkout = checkoutResult.parse(checkoutData);
                  const next = depositNextAction(checkout, result.deposit.id, provider);
                  if (next.action === 'AWAIT_CONFIRMATION') {
                    checkoutStatus.textContent =
                      'Pagamento ricevuto e verificato: il tuo tavolo è prenotato.';
                  } else if (next.action === 'FAILED') {
                    checkoutStatus.textContent =
                      'Pagamento non riuscito. Contatta il ristorante per verificare la prenotazione.';
                  } else if (next.action === 'REDIRECT') {
                    checkoutStatus.textContent = 'Apertura della pagina di pagamento…';
                    window.location.assign(next.url);
                  } else {
                    checkoutStatus.textContent =
                      'Il pagamento è in elaborazione. Contatta il ristorante prima di riprovare.';
                  }
                } catch (error) {
                  checkoutStatus.textContent =
                    'Impossibile verificare l’avvio del pagamento. Non ripetere la richiesta; contatta il ristorante.';
                  throw error;
                }
              },
              provider === result.deposit.providers[0] ? 'primary' : 'secondary',
            ),
          );
        }
        form.append(checkoutStatus, phoneLink(venue));
      } else {
        form.replaceChildren(
          el('p', { class: 'eyebrow' }, 'A presto'),
          el(
            'h2',
            {},
            result.status === 'RESERVED'
              ? 'Il tuo tavolo è prenotato.'
              : 'Abbiamo ricevuto la richiesta.',
          ),
          el(
            'p',
            {},
            result.status === 'REQUESTED'
              ? 'Il ristorante deve ancora confermare il tuo gruppo.'
              : 'Ti aspettiamo. Per modifiche o cancellazioni, contatta il ristorante.',
          ),
          el('a', { href: `tel:${venue.phone.replace(/[^+0-9]/g, '')}` }, venue.phone),
        );
      }
    } catch (error) {
      // A request may already have committed even if its response was lost: never create a second booking.
      status.textContent =
        'Non è possibile verificare l’esito dell’invio. Non ripetere la prenotazione: contatta il ristorante.';
      throw error;
    }
  });
  form.append(submit);
  return form;
}
