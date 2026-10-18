import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { stepUp } from '../auth/step-up';
import { button, dialog, el, field, status, toast } from '../components/dom';
import type { StaffContext } from './staff-context';

// §6, §8 e STEP 10: il Super Admin crea, modifica, disattiva e riattiva le sedi della catena.
// Le regole (licenza MULTI_VENUE, limite sedi, almeno una sede attiva, step-up, idempotenza,
// audit VENUE_*) restano nelle RPC create_venue/update_venue: qui si raccolgono solo i dati.
const venueRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  code: z.string(),
  address: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  timezone: z.string(),
  currency: z.string(),
  locale: z.string(),
  active: z.boolean(),
  operational_status: z.string(),
  version: z.number().int(),
});
type VenueRow = z.infer<typeof venueRowSchema>;
const record = z.record(z.string(), z.unknown());
const statusLabels: Record<string, string> = {
  OPEN: 'Aperta',
  CLOSED: 'Chiusa',
  MAINTENANCE: 'In manutenzione',
};

export function venueSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function venueForm(existing?: VenueRow) {
  const name = field('Nome sede', 'venue_name', 'text', existing?.name ?? '');
  const slug = field('Percorso della pagina sede', 'venue_slug', 'text', existing?.slug ?? '');
  const code = field('Codice sede', 'venue_code', 'text', existing?.code ?? '');
  const address = field('Indirizzo', 'venue_address', 'text', existing?.address ?? '');
  const phone = field('Telefono', 'venue_phone', 'tel', existing?.phone ?? '');
  const email = field('Email (facoltativa)', 'venue_email', 'email', existing?.email ?? '');
  const timezone = field(
    'Fuso orario',
    'venue_timezone',
    'text',
    existing?.timezone ?? 'Europe/Rome',
  );
  const operational = el(
    'select',
    { 'aria-label': 'Stato operativo' },
    ...Object.entries(statusLabels).map(([value, label]) => el('option', { value }, label)),
  );
  operational.value = existing?.operational_status ?? 'OPEN';
  for (const input of [name, slug, code, address, phone, timezone]) input.input.required = true;
  name.input.maxLength = 160;
  slug.input.pattern = '[a-z0-9]+(-[a-z0-9]+)*';
  slug.input.maxLength = 60;
  code.input.pattern = '[A-Za-z0-9][A-Za-z0-9_\\-]{1,31}';
  address.input.minLength = 3;
  phone.input.minLength = 3;
  if (!existing)
    name.input.addEventListener('input', () => {
      slug.input.value = venueSlug(name.input.value);
    });
  const roots = [
    name.root,
    slug.root,
    code.root,
    address.root,
    phone.root,
    email.root,
    timezone.root,
    el('label', {}, 'Stato operativo', operational),
  ];
  const valid = () =>
    [name, slug, code, address, phone, email, timezone].every((input) =>
      input.input.reportValidity(),
    );
  const values = () => ({
    name: name.input.value.trim(),
    slug: slug.input.value.trim(),
    code: code.input.value.trim().toUpperCase(),
    address: address.input.value.trim(),
    phone: phone.input.value.trim(),
    email: email.input.value.trim() || null,
    timezone: timezone.input.value.trim(),
    operational_status: operational.value,
  });
  return { roots, valid, values };
}

export async function venuesPage(context: StaffContext): Promise<HTMLElement> {
  const venues = await readRows('venues', venueRowSchema);
  const multiVenue = context.multiVenue;
  const activeCount = venues.filter((venue) => venue.active).length;
  const view = el('div', { class: 'stack' });
  view.append(
    el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Sedi della catena'),
      el(
        'p',
        { class: 'muted' },
        multiVenue
          ? `${activeCount} sedi attive. Ogni nuova sede parte vuota: sale, tavoli, menu della sede e staff si configurano dall’Admin.`
          : 'La licenza multi-sede non è attiva: puoi aggiornare i dati della sede, ma non aggiungerne altre. Attiva MULTI_VENUE in Operational Health.',
      ),
      multiVenue
        ? button('Nuova sede', () => {
            const form = venueForm();
            const key = crypto.randomUUID();
            const popup = dialog('Nuova sede', ...form.roots);
            popup.append(
              button('Crea sede', async () => {
                if (!form.valid()) return;
                const values = form.values();
                const grant = await stepUp('FEATURE_CHANGE');
                await rpc(
                  'create_venue',
                  {
                    p_name: values.name,
                    p_slug: values.slug,
                    p_code: values.code,
                    p_address: values.address,
                    p_phone: values.phone,
                    p_email: values.email,
                    p_timezone: values.timezone,
                    p_currency: 'EUR',
                    p_locale: 'it-IT',
                    p_grant: grant,
                    p_key: key,
                  },
                  record,
                );
                popup.close();
                toast(`Sede ${values.name} creata.`);
                await context.refresh?.();
              }),
            );
          })
        : null,
    ),
  );
  for (const venue of venues) {
    const card = el(
      'article',
      { class: 'card stack', 'data-venue-id': venue.id },
      el(
        'div',
        { class: 'row between' },
        el('h3', {}, venue.name),
        status(venue.active ? (statusLabels[venue.operational_status] ?? 'Attiva') : 'Disattivata'),
      ),
      el(
        'p',
        { class: 'muted' },
        `${venue.code} · /sedi/${venue.slug} · ${venue.address} · ${venue.phone} · ${venue.timezone}`,
      ),
    );
    const update = async (values: Record<string, unknown>, done: string, close?: () => void) => {
      const key = crypto.randomUUID();
      const grant = await stepUp('FEATURE_CHANGE');
      await rpc(
        'update_venue',
        {
          p_venue: venue.id,
          p_version: venue.version,
          p_values: values,
          p_grant: grant,
          p_key: key,
        },
        record,
      );
      close?.();
      toast(done);
      await context.refresh?.();
    };
    const actions = el(
      'div',
      { class: 'row' },
      button(
        'Modifica sede',
        () => {
          const form = venueForm(venue);
          const popup = dialog(`Modifica ${venue.name}`, ...form.roots);
          popup.append(
            button('Salva sede', async () => {
              if (!form.valid()) return;
              const next = form.values();
              const changed = Object.fromEntries(
                Object.entries(next).filter(
                  ([field, value]) => value !== (venue as Record<string, unknown>)[field],
                ),
              );
              if (!Object.keys(changed).length) {
                popup.close();
                return;
              }
              await update(changed, 'Sede aggiornata.', () => popup.close());
            }),
          );
        },
        'secondary',
      ),
    );
    if (venue.active && activeCount > 1)
      actions.append(
        button(
          'Disattiva sede',
          () => {
            const popup = dialog(
              `Disattiva ${venue.name}`,
              el(
                'p',
                {},
                'La sede non sarà più visibile sul sito né selezionabile dallo staff. Dati, conti e audit restano conservati.',
              ),
            );
            popup.append(
              button(
                'Conferma disattivazione',
                () => update({ active: false }, 'Sede disattivata.', () => popup.close()),
                'danger',
              ),
            );
          },
          'secondary',
        ),
      );
    if (!venue.active && multiVenue)
      actions.append(
        button('Riattiva sede', () => update({ active: true }, 'Sede riattivata.'), 'secondary'),
      );
    card.append(actions);
    view.append(card);
  }
  return view;
}
