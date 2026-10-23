import { z } from 'zod';
import { readPage, readRows } from '../api/client';
import { button, el, emptyState, showError, status } from '../components/dom';
import { formatMoney } from '../services/money';
import { venueDishSetupState } from '../services/venue-menu-status';
import { venueDishDialog } from './catalog';
import type { StaffContext } from './staff-context';

const id = z.uuid();
const dishSchema = z.object({
  id,
  name: z.string(),
  category_id: id,
  price_cents: z.number().int().nonnegative(),
  active: z.boolean(),
});
const categorySchema = z.object({ id, name: z.string(), active: z.boolean() });
const stationSchema = z.object({ id, name: z.string(), active: z.boolean() });
const localSettingsSchema = z.object({
  dish_id: id,
  enabled: z.boolean(),
  availability: z.number().int().nonnegative().nullable(),
  availability_date: z.string().nullable(),
  local_station_id: id.nullable(),
});
const stationAssignmentSchema = z.object({
  dish_id: id,
  station_id: id,
  is_primary: z.boolean(),
});

const labels = {
  DISABLED: 'Disattivato per la sede',
  SOLD_OUT: 'Disponibilità da aggiornare',
  NEEDS_STATION: 'Stazione da configurare',
  CONFIGURED: 'Configurato per la sede',
} as const;

/**
 * Venue-scoped operational overrides; catalog creation/editing is still
 * restricted to CHAIN Admins when MULTI_VENUE is enabled.
 */
export async function venueMenuPage(context: StaffContext): Promise<HTMLElement> {
  if (context.profile.role !== 'ADMIN')
    return emptyState(
      'Accesso non autorizzato',
      'La configurazione dei piatti per sede è riservata agli Admin.',
    );
  const selectedVenue = context.venue;
  if (!selectedVenue) return emptyState('Nessuna sede', 'Seleziona la sede autorizzata.');
  const venue = selectedVenue;

  let [categories, stations] = await Promise.all([
    readRows('categories', categorySchema, undefined, { active: 'true' }),
    readRows('stations', stationSchema, venue.id, { active: 'true' }),
  ]);
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const stationNames = new Map(stations.map((station) => [station.id, station.name]));
  const activeStations = new Set(stations.map((station) => station.id));
  const categoryFilter = el(
    'select',
    { 'aria-label': 'Filtra per categoria' },
    el('option', { value: '' }, 'Tutte le categorie'),
    ...categories.map((category) => el('option', { value: category.id }, category.name)),
  );
  function venueLocalDate(): string {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: venue.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    return ['year', 'month', 'day']
      .map((part) => parts.find((item) => item.type === part)?.value)
      .join('-');
  }

  const rows = el('section', { class: 'stack', 'aria-label': 'Piatti del catalogo' });
  const feedback = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const stationFeedback = el('p', { role: 'status' });
  stationFeedback.textContent = stations.length
    ? ''
    : 'Non ci sono stazioni attive: configura una stazione prima di salvare piatti.';
  let cursor: string | null = null;
  let displayed = 0;
  let revision = 0;
  const loadMore = button('Carica altri piatti', async () => load(false), 'secondary');

  async function load(reset: boolean): Promise<void> {
    const currentRevision = ++revision;
    const localDate = venueLocalDate();
    const result = await readPage('dishes', dishSchema, {
      filters: {
        active: 'true',
        ...(categoryFilter.value ? { category_id: categoryFilter.value } : {}),
      },
      after: reset ? null : cursor,
      limit: 25,
    });
    const ids = result.rows.map((dish) => dish.id);
    const [overrides, assignments] = ids.length
      ? await Promise.all([
          readRows('venue_dish_settings', localSettingsSchema, venue.id, { dish_id: ids }),
          readRows('dish_station_assignments', stationAssignmentSchema, venue.id, {
            dish_id: ids,
            is_primary: 'true',
          }),
        ])
      : [[], []];
    if (currentRevision !== revision) return;
    const byDish = new Map(overrides.map((override) => [override.dish_id, override]));
    const primaryByDish = new Map(
      assignments
        .filter((assignment) => assignment.is_primary)
        .map((assignment) => [assignment.dish_id, assignment.station_id]),
    );
    if (reset) {
      rows.replaceChildren();
      displayed = 0;
    }
    for (const dish of result.rows) {
      const override = byDish.get(dish.id);
      const stationId = override?.local_station_id ?? primaryByDish.get(dish.id);
      const current = venueDishSetupState(
        override,
        primaryByDish.get(dish.id),
        activeStations,
        localDate,
      );
      rows.append(
        el(
          'article',
          { class: 'card row between' },
          el(
            'div',
            { class: 'stack' },
            el('h3', {}, dish.name),
            el(
              'p',
              { class: 'muted' },
              `${categoryNames.get(dish.category_id) ?? 'Categoria da verificare'} · ${formatMoney(dish.price_cents, venue.currency, venue.locale)} catalogo`,
            ),
            el(
              'p',
              { class: 'muted' },
              stationId
                ? `Stazione: ${stationNames.get(stationId) ?? 'non attiva'}`
                : 'Nessuna stazione assegnata',
            ),
            status(
              categoryNames.has(dish.category_id)
                ? labels[current]
                : 'Categoria non attiva: richiede Admin di catena',
            ),
          ),
          stations.length
            ? button('Configura per questa sede', () => venueDishDialog(context, dish), 'secondary')
            : el('span', { class: 'muted' }, 'Configura prima una stazione'),
        ),
      );
    }
    displayed += result.rows.length;
    cursor = result.next;
    loadMore.hidden = !cursor;
    feedback.textContent = `${displayed} piatti caricati`;
    if (!displayed)
      rows.append(
        emptyState(
          'Nessun piatto nel catalogo',
          'Un Admin di catena deve creare almeno un piatto attivo prima delle disponibilità locali.',
        ),
      );
  }

  categoryFilter.addEventListener('change', () => {
    void load(true).catch(showError);
  });
  context.refresh = async () => {
    const currentRevision = ++revision;
    const [updatedCategories, updatedStations] = await Promise.all([
      readRows('categories', categorySchema, undefined, { active: 'true' }),
      readRows('stations', stationSchema, venue.id, { active: 'true' }),
    ]);
    if (currentRevision !== revision || context.venue?.id !== venue.id) return;
    categories = updatedCategories;
    stations = updatedStations;
    categoryNames.clear();
    stationNames.clear();
    activeStations.clear();
    for (const category of categories) categoryNames.set(category.id, category.name);
    for (const station of stations) {
      stationNames.set(station.id, station.name);
      activeStations.add(station.id);
    }
    const selected = categoryFilter.value;
    categoryFilter.replaceChildren(
      el('option', { value: '' }, 'Tutte le categorie'),
      ...categories.map((category) => el('option', { value: category.id }, category.name)),
    );
    categoryFilter.value = categoryNames.has(selected) ? selected : '';
    stationFeedback.textContent = stations.length
      ? ''
      : 'Non ci sono stazioni attive: configura una stazione prima di salvare piatti.';
    await load(true);
  };
  const root = el(
    'div',
    { class: 'stack' },
    el(
      'header',
      { class: 'card stack' },
      el('p', { class: 'eyebrow' }, 'MENU DELLA SEDE'),
      el('h2', {}, `Disponibilità · ${venue.name}`),
      el(
        'p',
        { class: 'muted' },
        'Personalizza prezzi, scorte e stazione principale della sede senza modificare il catalogo condiviso. Le autorizzazioni e i controlli di versione sono applicati dal server.',
      ),
      stationFeedback,
      button(
        'Configurazione stazioni',
        () => context.navigate('/gestione?modulo=stations'),
        'secondary',
      ),
    ),
    el('label', { class: 'field' }, 'Categoria', categoryFilter),
    feedback,
    rows,
    loadMore,
  );
  await load(true);
  return root;
}
