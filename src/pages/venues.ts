import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import { stepUp } from '../auth/step-up';
import type { StaffContext } from './staff-context';

// All writes are performed by version-checked, audited, Super Admin-only RPCs.
// A step-up grant is consumed by PostgreSQL for each sensitive operation.
const venueRow = z.object({
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
  version: z.number().int(),
});
type VenueRow = z.infer<typeof venueRow>;
const savedVenue = z.object({ id: z.uuid(), version: z.number().int() });

const slugify = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export async function venuesPage(context: StaffContext): Promise<HTMLElement> {
  const view = el('div', { class: 'stack' });
  if (context.profile.role !== 'SUPER_ADMIN') return el('p', {}, 'Accesso non autorizzato.');
  const rows = await readRows('venues', venueRow);
  const active = rows.filter((venue) => venue.active);
  const multiVenue = context.licensedFeatures?.has('MULTI_VENUE') ?? false;
  const header = el(
    'section',
    { class: 'card stack' },
    el('h2', {}, 'Gestione sedi'),
    el(
      'p',
      { class: 'muted' },
      'Ogni sede ha dati operativi isolati, permessi dedicati e uno storico delle modifiche.',
    ),
  );
  view.append(header);
  if (!multiVenue)
    header.append(
      el(
        'p',
        { role: 'status' },
        'La licenza multi-sede non è attiva. Per aggiungere una sede occorre abilitare MULTI_VENUE.',
      ),
    );
  else header.append(button('Nuova sede', () => editVenue()));

  function editVenue(existing?: VenueRow): void {
    const name = field('Nome sede', 'venue-name', 'text', existing?.name ?? '');
    const slug = field('Percorso della pagina sede', 'venue-slug', 'text', existing?.slug ?? '');
    const code = field('Codice sede', 'venue-code', 'text', existing?.code ?? '');
    const address = field('Indirizzo', 'venue-address', 'text', existing?.address ?? '');
    const phone = field('Telefono', 'venue-phone', 'tel', existing?.phone ?? '');
    const email = field('Email', 'venue-email', 'email', existing?.email ?? '');
    let manuallyEditedSlug = Boolean(existing);
    slug.input.addEventListener('input', () => {
      manuallyEditedSlug = true;
    });
    name.input.addEventListener('input', () => {
      if (!manuallyEditedSlug) slug.input.value = slugify(name.input.value);
    });
    for (const control of [name, slug, code, address, phone])
      control.input.required = true;
    slug.input.pattern = '[a-z0-9]+(-[a-z0-9]+)*';
    code.input.pattern = '[a-zA-Z0-9][a-zA-Z0-9_-]+';
    const popup = dialog(
      existing ? `Modifica ${existing.name}` : 'Nuova sede',
      name.root,
      slug.root,
      code.root,
      address.root,
      phone.root,
      email.root,
    );
    const key = crypto.randomUUID();
    popup.append(
      button(existing ? 'Salva sede' : 'Crea sede', async () => {
        if (
          [name, slug, code, address, phone, email].some(
            (control) => !control.input.reportValidity(),
          )
        )
          return;
        const grant = await stepUp('FEATURE_CHANGE');
        if (existing) {
          await rpc(
            'update_venue',
            {
              p_venue: existing.id,
              p_version: existing.version,
              p_values: {
                name: name.input.value,
                slug: slug.input.value,
                code: code.input.value,
                address: address.input.value,
                phone: phone.input.value,
                email: email.input.value || null,
              },
              p_grant: grant,
              p_key: key,
            },
            savedVenue,
          );
          toast('Sede aggiornata.');
        } else {
          await rpc(
            'create_venue',
            {
              p_name: name.input.value,
              p_slug: slug.input.value,
              p_code: code.input.value,
              p_address: address.input.value,
              p_phone: phone.input.value,
              p_email: email.input.value || null,
              p_timezone: context.venue?.timezone ?? 'Europe/Rome',
              p_currency: context.venue?.currency ?? 'EUR',
              p_locale: context.venue?.locale ?? 'it-IT',
              p_grant: grant,
              p_key: key,
            },
            savedVenue,
          );
          toast(`Sede ${name.input.value} creata.`);
        }
        popup.close();
        await context.refresh?.();
      }),
    );
  }

  for (const venue of rows) {
    const card = el(
      'article',
      { class: 'card stack' },
      el('h3', {}, venue.name),
      el('p', { class: 'muted' }, `${venue.code} · /sedi/${venue.slug}`),
      el('p', {}, venue.address),
      el('p', {}, venue.phone),
      el('p', {}, venue.active ? 'Attiva' : 'Non attiva'),
      button('Modifica sede', () => editVenue(venue), 'secondary'),
    );
    if (venue.active && active.length > 1)
      card.append(
        button(
          'Disattiva sede',
          () => {
            const popup = dialog(
              `Disattiva ${venue.name}`,
              el(
                'p',
                {},
                'La sede non sarà più pubblicata e non potrà essere selezionata per nuove operazioni.',
              ),
            );
            const key = crypto.randomUUID();
            popup.append(
              button('Conferma disattivazione', async () => {
                const grant = await stepUp('FEATURE_CHANGE');
                await rpc(
                  'update_venue',
                  {
                    p_venue: venue.id,
                    p_version: venue.version,
                    p_values: { active: false },
                    p_grant: grant,
                    p_key: key,
                  },
                  savedVenue,
                );
                popup.close();
                toast('Sede disattivata.');
                await context.refresh?.();
              }),
            );
          },
          'secondary',
        ),
      );
    view.append(card);
  }
  return view;
}
