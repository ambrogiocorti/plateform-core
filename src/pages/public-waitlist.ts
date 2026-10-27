import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { client, rpc } from '../api/client';
import { button, el, emptyState, field } from '../components/dom';
import type { Venue } from '../types/domain';
import { addCalendarDays, venueLocalToday } from '../services/public-booking-contract';
import {
  readWaitlistOfferFragment,
  waitlistAcceptResponse,
  waitlistCreateResponse,
  waitlistServiceTimes,
} from '../services/waitlist';

const servicesSchema = z.object({
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
});

function telephone(venue: Venue): HTMLElement {
  return el('a', { href: `tel:${venue.phone.replace(/[^+0-9]/g, '')}` }, venue.phone);
}

async function waitlistError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const data = z.object({ code: z.string() }).parse(await error.context.json());
      if (data.code === 'WAITLIST_DISABLED')
        return 'La lista d’attesa non è attiva per questa sede.';
      if (data.code === 'RATE_LIMITED') return 'Troppe richieste. Riprova più tardi.';
      if (
        data.code === 'WAITLIST_DATE_UNAVAILABLE' ||
        data.code === 'WAITLIST_TIME_UNAVAILABLE' ||
        data.code === 'WAITLIST_IN_PAST'
      )
        return 'La data o l’orario richiesti non sono disponibili.';
      if (data.code === 'WAITLIST_ACCESS_DENIED' || data.code === 'WAITLIST_OFFER_EXPIRED')
        return 'Il link non è valido oppure l’offerta è scaduta. Contatta il ristorante.';
      if (data.code === 'WAITLIST_CAPACITY_LOST')
        return 'Il posto non è più disponibile. Contatta il ristorante.';
    } catch {
      /* Never display server messages or token values. */
    }
  }
  return 'Non è possibile verificare l’esito. Non ripetere la richiesta: contatta il ristorante.';
}

export async function waitlistPage(venue: Venue, privacyUrl?: string): Promise<HTMLElement> {
  if (!venue.reservations_enabled || !privacyUrl?.startsWith('https://'))
    return emptyState('Lista d’attesa non disponibile', 'Contatta il ristorante per informazioni.');
  const config = await rpc(
    'get_booking_configuration',
    { p_venue: venue.id },
    servicesSchema.nullable(),
  );
  if (!config?.services.length)
    return emptyState(
      'Nessun servizio disponibile',
      'Contatta il ristorante per verificare gli orari.',
    );

  const firstName = field('Nome e cognome', 'waitlist-name');
  const phone = field('Telefono con prefisso internazionale', 'waitlist-phone', 'tel');
  phone.input.placeholder = '+39';
  phone.input.pattern = '\\+[0-9]{7,15}';
  const party = field('Persone', 'waitlist-party', 'number', '2');
  party.input.min = '1';
  party.input.max = '1000';
  party.input.step = '1';
  const date = field('Data', 'waitlist-date', 'date');
  date.input.min = venueLocalToday(venue.timezone);
  date.input.max = addCalendarDays(date.input.min, 180);
  const notes = field('Note (facoltative)', 'waitlist-notes');
  notes.input.maxLength = 2000;
  for (const entry of [firstName, phone, party, date]) entry.input.required = true;

  const service = el(
    'select',
    { 'aria-label': 'Servizio lista d’attesa' },
    ...config.services.map((entry) => el('option', { value: entry.id }, entry.name)),
  );
  const preferredStart = el('select', { 'aria-label': 'Orario preferito' });
  const preferredEnd = el('select', { 'aria-label': 'Fine fascia preferita (facoltativa)' });
  const refreshTimes = () => {
    const current = config.services.find((entry) => entry.id === service.value);
    const times = current
      ? waitlistServiceTimes(current.starts_at, current.ends_at, current.slot_interval_minutes)
      : [];
    preferredStart.replaceChildren(
      el('option', { value: '' }, 'Scegli un orario'),
      ...times.map((t) => el('option', { value: t }, t)),
    );
    preferredEnd.replaceChildren(
      el('option', { value: '' }, 'Nessun limite'),
      ...times.map((t) => el('option', { value: t }, t)),
    );
  };
  refreshTimes();
  service.addEventListener('change', refreshTimes);
  preferredStart.required = true;
  const consent = el('input', { type: 'checkbox', required: '', id: 'waitlist-consent' });
  const feedback = el('p', { role: 'status', 'aria-live': 'polite' });
  const form = el(
    'section',
    { class: 'booking-form card stack' },
    el('h2', {}, `Lista d’attesa · ${venue.name}`),
    el(
      'p',
      { class: 'muted' },
      'La richiesta non è una prenotazione. Ti contatteremo soltanto se si libera un posto compatibile.',
    ),
    firstName.root,
    phone.root,
    party.root,
    date.root,
    el('label', {}, 'Servizio', service),
    el('label', {}, 'Orario preferito', preferredStart),
    el('label', {}, 'Fine fascia preferita', preferredEnd),
    notes.root,
    el(
      'label',
      {},
      consent,
      ' Ho letto l’',
      el(
        'a',
        { href: privacyUrl, target: '_blank', rel: 'noopener noreferrer' },
        'informativa privacy',
      ),
      ' e autorizzo l’uso dei dati per questa richiesta.',
    ),
    feedback,
  );
  const requestKey = crypto.randomUUID();
  let attempted = false;
  form.append(
    button('Entra in lista d’attesa', async () => {
      if (attempted) return;
      if (
        [firstName, phone, party, date].some((entry) => !entry.input.reportValidity()) ||
        !preferredStart.reportValidity() ||
        !consent.reportValidity()
      )
        return;
      const current = config.services.find((entry) => entry.id === service.value);
      if (
        !current ||
        !waitlistServiceTimes(
          current.starts_at,
          current.ends_at,
          current.slot_interval_minutes,
        ).includes(preferredStart.value)
      ) {
        feedback.textContent = 'Scegli un orario valido per il servizio selezionato.';
        return;
      }
      const startIndex = waitlistServiceTimes(
        current.starts_at,
        current.ends_at,
        current.slot_interval_minutes,
      ).indexOf(preferredStart.value);
      const endIndex = waitlistServiceTimes(
        current.starts_at,
        current.ends_at,
        current.slot_interval_minutes,
      ).indexOf(preferredEnd.value);
      if (preferredEnd.value && endIndex < startIndex) {
        feedback.textContent = 'La fine della fascia deve seguire l’orario iniziale.';
        return;
      }
      attempted = true;
      feedback.textContent = 'Stiamo inviando la richiesta…';
      try {
        const { data, error } = await client().functions.invoke('waitlist', {
          body: {
            action: 'CREATE',
            venue_id: venue.id,
            service_id: service.value,
            date: date.input.value,
            preferred_start: preferredStart.value,
            preferred_end: preferredEnd.value || null,
            party_size: Number(party.input.value),
            customer_name: firstName.input.value.trim(),
            customer_phone: phone.input.value,
            notes: notes.input.value.trim() || null,
            idempotency_key: requestKey,
          },
        });
        if (error) {
          const message = await waitlistError(error);
          form.replaceChildren(
            el('h2', {}, 'Esito non confermato'),
            el('p', { role: 'alert' }, message),
            telephone(venue),
          );
          return;
        }
        waitlistCreateResponse.parse(data);
        form.replaceChildren(
          el('h2', {}, 'Sei in lista d’attesa'),
          el(
            'p',
            {},
            'Abbiamo ricevuto la tua richiesta. Non hai ancora un tavolo prenotato: il ristorante ti contatterà in caso di disponibilità.',
          ),
          telephone(venue),
        );
      } catch {
        form.replaceChildren(
          el('h2', {}, 'Esito non verificabile'),
          el(
            'p',
            { role: 'alert' },
            'Non inviare una nuova richiesta: contatta il ristorante per controllare lo stato.',
          ),
          telephone(venue),
        );
      }
    }),
  );
  return form;
}

export function waitlistOfferPage(fragment: string): HTMLElement {
  // The route bootstrap already removed the fragment before async page loading.
  const offer = readWaitlistOfferFragment(fragment);
  if (!offer)
    return emptyState(
      'Link non valido',
      'Richiedi al ristorante un nuovo collegamento di conferma.',
    );

  let attempted = false;
  const result = el(
    'section',
    { class: 'public-section booking-form stack' },
    el('p', { class: 'eyebrow' }, 'Lista d’attesa'),
    el('h1', {}, 'Un posto potrebbe essersi liberato'),
    el(
      'p',
      {},
      'Confermando, il sistema verificherà nuovamente la disponibilità. Fino alla conferma non hai una prenotazione.',
    ),
  );
  const message = el('p', { role: 'status', 'aria-live': 'polite' });
  result.append(
    message,
    button('Accetta il posto proposto', async () => {
      if (attempted) return;
      attempted = true;
      message.textContent = 'Verifica disponibilità e conferma in corso…';
      try {
        const { data, error } = await client().functions.invoke('waitlist', {
          body: {
            action: 'ACCEPT',
            entry_id: offer.entry,
            access_token: offer.token,
            idempotency_key: acceptanceKey,
          },
        });
        if (error) {
          message.textContent = await waitlistError(error);
          return;
        }
        const accepted = waitlistAcceptResponse.parse(data);
        result.replaceChildren(
          el(
            'h1',
            {},
            accepted.reservation_status === 'RESERVED'
              ? 'Prenotazione confermata'
              : 'Prenotazione in attesa di caparra',
          ),
          el(
            'p',
            {},
            accepted.reservation_status === 'RESERVED'
              ? 'Il posto è stato assegnato. Per modifiche contatta il ristorante.'
              : 'La prenotazione non è ancora definitiva: contatta il ristorante per completare la caparra con un metodo abilitato.',
          ),
        );
      } catch {
        message.textContent =
          'L’esito non è verificabile. Non utilizzare un altro link senza contattare il ristorante.';
      }
    }),
  );
  const acceptanceKey = crypto.randomUUID();
  return result;
}
