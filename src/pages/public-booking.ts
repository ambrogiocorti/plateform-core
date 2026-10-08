import { bookingField } from '../components/booking-fields';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApplicationError, client, rpc, safeError } from '../api/client';
import { button, el, emptyState, field } from '../components/dom';
import type { Venue } from '../types/domain';

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

export async function bookingPage(venue: Venue): Promise<HTMLElement> {
  if (!venue.reservations_enabled)
    return emptyState(
      'Prenotazioni online non disponibili',
      `Per prenotare, contattaci al ${venue.phone}.`,
    );
  const configuration = await rpc(
    'get_booking_configuration',
    { p_venue: venue.id },
    bookingSchema,
  );
  if (!configuration.services.length)
    return emptyState(
      'Prenota con noi',
      `Contattaci al ${venue.phone} per verificare le disponibilità.`,
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
  const date = field('Data', 'date', 'date');
  for (const input of [first, last, phone, party, date]) input.input.required = true;
  const service = el(
    'select',
    { 'aria-label': 'Servizio' },
    ...configuration.services.map((entry) => el('option', { value: entry.id }, entry.name)),
  );
  const time = el('select', { 'aria-label': 'Orario' });
  const updateTimes = () => {
    const current = configuration.services.find((entry) => entry.id === service.value);
    if (!current) return;
    const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
    const start = minutes(current.starts_at);
    let end = minutes(current.ends_at);
    if (end <= start) end += 1440;
    time.replaceChildren();
    for (let minute = start; minute < end; minute += current.slot_interval_minutes) {
      const value = `${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      time.append(el('option', { value }, value));
    }
  };
  service.addEventListener('change', updateTimes);
  updateTimes();
  form.append(
    el('h2', {}, `Un tavolo da ${venue.name}`),
    el(
      'p',
      { class: 'muted' },
      'Scegli quando venirci a trovare. La disponibilità viene verificata al momento della richiesta.',
    ),
    ...[first, last, phone, party, date].map((input) => input.root),
    el('div', { class: 'field' }, el('label', {}, 'Servizio', service)),
    el('div', { class: 'field' }, el('label', {}, 'Orario', time)),
  );
  const answers = new Map(configuration.fields.map((entry) => [entry.id, bookingField(entry)]));
  for (const input of answers.values()) form.append(input.root);
  const key = crypto.randomUUID();
  form.append(
    el(
      'p',
      { class: 'muted' },
      'Per modificare o cancellare la prenotazione, contatta il ristorante.',
    ),
    button('Richiedi il tavolo', async () => {
      if (
        [first, last, phone, party, date].some((entry) => !entry.input.reportValidity()) ||
        [...answers.values()].some((input) => !input.valid())
      )
        return;
      const response: Record<string, unknown> = {};
      for (const [id, input] of answers) response[id] = input.value();
      const { data, error } = await client().functions.invoke('reservation', {
        body: {
          venue_id: venue.id,
          service_id: service.value,
          date: date.input.value,
          time: time.value,
          first_name: first.input.value,
          last_name: last.input.value,
          phone: phone.input.value,
          party_size: Number(party.input.value),
          answers: response,
          idempotency_key: key,
        },
      });
      if (error) await bookingFailure(error);
      const result = z
        .object({ id: z.uuid(), status: z.enum(['RESERVED', 'REQUESTED']) })
        .parse(data);
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
            ? 'Il ristorante deve confermare la disponibilità per il tuo gruppo. Contattaci per maggiori informazioni.'
            : 'Ti aspettiamo. Per modifiche o cancellazioni, contatta il ristorante.',
        ),
        el('a', { href: `tel:${venue.phone}` }, venue.phone),
      );
    }),
  );
  return form;
}
