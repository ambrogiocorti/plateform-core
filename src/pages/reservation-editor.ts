import { bookingField } from '../components/booking-fields';
import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import type { StaffContext } from './staff-context';
const detailsSchema = z.object({
  reservation: z.object({
    id: z.uuid(),
    version: z.number().int(),
    service_id: z.uuid(),
    service_date: z.string(),
    slot_time: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    phone: z.string(),
    party_size: z.number().int(),
    customer_note: z.string().nullable(),
    internal_note: z.string().nullable(),
    allergies: z.string().nullable(),
  }),
  answers: z.record(z.string(), z.unknown()),
});
const bookingFieldSchema = z.object({
  id: z.uuid(),
  type: z.enum([
    'text',
    'textarea',
    'number',
    'select',
    'checkbox',
    'radio',
    'tel',
    'date',
    'time',
  ]),
  label: z.string(),
  required: z.boolean(),
  options: z.array(z.string()),
  placeholder: z.string().nullable().optional(),
});
export async function reservationEditor(
  context: StaffContext,
  date: string,
  existing?: string,
): Promise<void> {
  if (!context.venue) return;
  const venue = context.venue;
  const [services, configuration, details] = await Promise.all([
    readRows(
      'services',
      z.object({ id: z.uuid(), name: z.string(), active: z.boolean(), starts_at: z.string() }),
      venue.id,
    ),
    rpc(
      'get_booking_configuration',
      { p_venue: venue.id },
      z.object({ fields: z.array(bookingFieldSchema) }),
    ),
    existing
      ? rpc('get_reservation_details', { p_reservation: existing }, detailsSchema)
      : Promise.resolve(null),
  ]);
  const saved = details?.reservation;
  const service = el(
    'select',
    { 'aria-label': 'Servizio' },
    ...services.filter((s) => s.active).map((s) => el('option', { value: s.id }, s.name)),
  );
  if (saved) service.value = saved.service_id;
  const inputs = {
    service_date: field('Giorno', 'date', 'date', saved?.service_date ?? date),
    slot_time: field(
      'Orario arrivo',
      'time',
      'time',
      saved?.slot_time.slice(0, 5) ??
        services.find((s) => s.id === service.value)?.starts_at.slice(0, 5) ??
        '',
    ),
    first_name: field('Nome', 'first', 'text', saved?.first_name ?? ''),
    last_name: field('Cognome', 'last', 'text', saved?.last_name ?? ''),
    phone: field('Telefono con prefisso internazionale', 'phone', 'tel', saved?.phone ?? '+39'),
    party_size: field('Persone', 'party', 'number', String(saved?.party_size ?? 2)),
    customer_note: field('Nota cliente', 'customer-note', 'text', saved?.customer_note ?? ''),
    internal_note: field('Nota interna', 'internal-note', 'text', saved?.internal_note ?? ''),
    allergies: field('Allergie comunicate', 'allergies', 'text', saved?.allergies ?? ''),
  };
  for (const name of ['service_date', 'slot_time', 'first_name', 'phone', 'party_size'] as const)
    inputs[name].input.required = true;
  inputs.party_size.input.min = '1';
  inputs.party_size.input.max = '1000';
  inputs.phone.input.pattern = '\\+[0-9]{7,15}';
  const popup = dialog(
    saved ? 'Modifica prenotazione' : 'Nuova prenotazione',
    el('label', {}, 'Servizio', service),
    ...Object.values(inputs).map((i) => i.root),
  );
  const answers = new Map(
    configuration.fields.map((entry) => [
      entry.id,
      bookingField(entry, details?.answers[entry.id]),
    ]),
  );
  for (const input of answers.values()) popup.append(input.root);
  const key = crypto.randomUUID();
  popup.append(
    button('Salva prenotazione', async () => {
      if (
        [
          ...popup.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            'input,select,textarea',
          ),
        ].some((input) => !input.reportValidity())
      )
        return;
      if ([...answers.values()].some((input) => !input.valid())) return;
      const custom = Object.fromEntries(
        [...answers.entries()].map(([id, input]) => [id, input.value()]),
      );
      if (
        configuration.fields.some(
          (entry) =>
            entry.required &&
            Array.isArray(custom[entry.id]) &&
            (custom[entry.id] as unknown[]).length === 0,
        )
      ) {
        toast('Completa i campi richiesti.', true);
        return;
      }
      const values = Object.fromEntries(
        Object.entries(inputs).map(([name, input]) => [
          name,
          name === 'party_size' ? Number(input.input.value) : input.input.value,
        ]),
      );
      await rpc(
        'save_staff_reservation',
        {
          p_venue: venue.id,
          p_id: saved?.id ?? null,
          p_version: saved?.version ?? null,
          p_values: { ...values, service_id: service.value },
          p_answers: custom,
          p_key: key,
        },
        z.object({ id: z.uuid() }),
      );
      popup.close();
      toast('Prenotazione salvata.');
      await context.refresh?.();
    }),
  );
}
