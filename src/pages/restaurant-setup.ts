import { z } from 'zod';
import { readPage, readRows } from '../api/client';
import { button, el, emptyState, status } from '../components/dom';
import { evaluateSetup, setupDefinitions } from '../services/setup-readiness';
import type { SetupFacts } from '../services/setup-readiness';
import { evaluateServicePreflight } from '../services/service-preflight';
import type { ServicePreflightInput } from '../services/service-preflight';
import type { StaffContext } from './staff-context';

const identity = z.object({ id: z.uuid() });

/**
 * Read only, tenant-scoped checks using the same PostgREST/RLS path as the
 * configuration screens. Never mark a step complete on network/permission error.
 * Deliberately checks presence, not hypothetical successful service operations.
 */
export async function loadSetupFacts(
  venueId: string,
  canManageSharedCatalog = true,
): Promise<SetupFacts> {
  const rows = await Promise.all(
    setupDefinitions.map(async (step) => {
      const shared = step.key === 'categories' || step.key === 'dishes';
      if (shared && !canManageSharedCatalog) return [step.key, 'MANAGED_BY_CHAIN'] as const;
      // Inactive rows do not enable a service, payment post or operational area.
      const filters = { active: 'true' };
      const result = await readPage(step.key, identity, {
        ...(shared ? {} : { venue: venueId }),
        filters,
        limit: 1,
      });
      return [step.key, result.rows.length > 0] as const;
    }),
  );
  return Object.fromEntries(rows) as SetupFacts;
}

const uuid = z.uuid();
const staff = z.object({ id: uuid, role: z.string(), active: z.boolean() });
const station = z.object({ id: uuid, active: z.boolean() });
const dish = z.object({
  id: uuid,
  category_id: uuid,
  active: z.boolean(),
  schedule_mode: z.string(),
  available_from: z.string().nullable(),
  available_until: z.string().nullable(),
  weekdays: z.array(z.number().int()).nullable(),
});
const category = z.object({ id: uuid, active: z.boolean() });
const venueStaff = z.object({ user_id: uuid, active: z.boolean() });
const stationStaff = z.object({
  user_id: uuid,
  station_id: uuid,
  active: z.boolean(),
});
const cashRegister = z.object({ id: uuid, active: z.boolean() });
const cashierAssignment = z.object({
  user_id: uuid,
  cash_register_id: uuid,
  active: z.boolean(),
});
const venueDish = z.object({
  dish_id: uuid,
  enabled: z.boolean(),
  availability: z.number().int().nonnegative().nullable(),
  availability_date: z.string().nullable(),
  local_station_id: uuid.nullable(),
});
const dishStation = z.object({
  dish_id: uuid,
  station_id: uuid,
  is_primary: z.boolean(),
});

/**
 * Queries use the authenticated PostgREST client with the selected venue and
 * existing RLS. Never use privileged RPCs or count another venue's personnel.
 */
export async function loadServicePreflight(
  venueId: string,
  timeZone: string,
): Promise<ReturnType<typeof evaluateServicePreflight>> {
  const [stations, profiles, assignments, stationAssignments, cashRegisters, cashiers] =
    await Promise.all([
      readRows('stations', station, venueId, { active: 'true' }),
      readRows('staff_profiles', staff, undefined, { active: 'true' }),
      readRows('staff_venue_assignments', venueStaff, venueId, { active: 'true' }),
      readRows('station_staff_assignments', stationStaff, venueId, { active: 'true' }),
      readRows('cash_registers', cashRegister, venueId, { active: 'true' }),
      readRows('cashier_assignments', cashierAssignment, venueId, { active: 'true' }),
    ]);
  const localParts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const localDate = ['year', 'month', 'day']
    .map((part) => localParts.find((entry) => entry.type === part)?.value)
    .join('-');
  // All staff roles may SELECT the shared menu through catalog_read RLS.
  // Only CHAIN admins may create/edit global catalog records; this code is read-only.
  const catalog = await Promise.all([
    readRows('dishes', dish, undefined, { active: 'true' }),
    readRows('categories', category, undefined, { active: 'true' }),
    readRows('venue_dish_settings', venueDish, venueId),
    readRows('dish_station_assignments', dishStation, venueId, { is_primary: 'true' }),
  ]);
  const input: ServicePreflightInput = {
    dishes: catalog[0],
    categories: catalog[1],
    venueDishes: catalog[2],
    dishStations: catalog[3],
    localDate,
    stations,
    profiles,
    venueStaff: assignments,
    stationStaff: stationAssignments,
    cashRegisters,
    cashiers,
  };
  return evaluateServicePreflight(input);
}

export async function restaurantSetupPage(context: StaffContext): Promise<HTMLElement> {
  if (context.profile.role !== 'ADMIN')
    return emptyState(
      'Accesso non autorizzato',
      'La preparazione del ristorante è riservata agli Admin.',
    );
  const venue = context.venue;
  if (!venue)
    return emptyState('Nessuna sede', 'Crea o seleziona una sede autorizzata per procedere.');

  const venueId = venue.id;
  const view = el('div', { class: 'stack restaurant-setup' });
  let revision = 0;

  async function refresh(): Promise<void> {
    // If the venue selection changes, do not reuse any previous venue's state.
    if (context.venue?.id !== venueId) return;
    const currentRevision = ++revision;
    const canManageSharedCatalog = !context.multiVenue || context.profile.scope === 'CHAIN';
    const [facts, operations] = await Promise.all([
      loadSetupFacts(venueId, canManageSharedCatalog),
      loadServicePreflight(venueId, venue.timezone),
    ]);
    if (currentRevision !== revision || context.venue?.id !== venueId) return;
    const progress = evaluateSetup(facts);
    const explanation = progress.basicsConfigured
      ? 'Sono presenti gli elementi minimi di configurazione. Verifica personale, turni, prezzi, disponibilità e l’intero ciclo operativo prima di aprire il servizio.'
      : 'Segui l’ordine indicato. Ogni stato è letto dal database della sede; non vengono creati dati dimostrativi.';

    const header = el(
      'header',
      { class: 'card stack' },
      el('p', { class: 'eyebrow' }, 'AVVIO GUIDATO'),
      el('h2', {}, `Prepara ${venue.name}`),
      el('p', { class: 'muted' }, explanation),
      el(
        'p',
        { role: 'status', 'aria-live': 'polite' },
        `${progress.completed} di ${progress.total} elementi minimi presenti`,
      ),
      button('Ricontrolla configurazione', refresh, 'secondary'),
    );
    if (progress.next)
      header.append(
        el(
          'div',
          { class: 'card stack' },
          el('strong', {}, `Prossimo passo: ${progress.next.title}`),
          el('p', {}, progress.next.description),
          progress.next.requiresChain
            ? el(
                'p',
                { class: 'muted' },
                'Questo catalogo è condiviso tra le sedi: richiedi la configurazione a un Admin di catena.',
              )
            : button('Vai alla configurazione', () => context.navigate(progress.next!.route)),
        ),
      );

    const list = el('ol', { class: 'stack', 'aria-label': 'Preparazione operativa' });
    for (const step of progress.steps)
      list.append(
        el(
          'li',
          { class: 'card row between' },
          el(
            'div',
            { class: 'stack' },
            el('h3', {}, step.title),
            el('p', { class: 'muted' }, step.description),
            status(
              step.requiresChain
                ? 'Richiede Admin di catena'
                : step.completed
                  ? 'Elemento presente'
                  : 'Da configurare',
            ),
          ),
          step.requiresChain
            ? el('span', { class: 'muted' }, 'Gestione della catena')
            : button(
                step.completed ? 'Apri' : 'Configura',
                () => context.navigate(step.route),
                'secondary',
              ),
        ),
      );

    view.replaceChildren(
      header,
      el('section', { class: 'stack' }, el('h2', {}, 'Configurazione della sede'), list),
      el(
        'section',
        { class: 'card stack' },
        el('h2', {}, 'Preparazione del servizio reale'),
        el(
          'p',
          { class: 'muted' },
          'Controlli server in sola lettura: personale autorizzato per questa sede e almeno un piatto abilitato e instradato a una stazione attiva. La presenza non dimostra ancora la riuscita di un ordine.',
        ),
        ...[
          {
            label: 'Piatto ordinabile con stazione attiva',
            completed:
              operations.orderableRoutedDishes === null
                ? null
                : operations.orderableRoutedDishes > 0,
            explanation:
              operations.orderableRoutedDishes === null
                ? 'Impossibile verificare il catalogo. Contatta un Admin di catena.'
                : `${operations.orderableRoutedDishes} piatti visibili oggi, non esauriti e collegati a una stazione attiva.`,
            path: '/menu-sede',
          },
          {
            label: 'Cameriere assegnato alla sede',
            completed: operations.waiterAssigned,
            explanation: 'Richiede un profilo cameriere attivo assegnato a questa sede.',
            path: '/staff',
          },
          {
            label: 'Personale cucina operativo',
            completed: operations.kitchenStaffed,
            explanation:
              'Richiede un Kitchen Admin assegnato o personale cucina attivo assegnato a una stazione attiva.',
            path: '/staff',
          },
          {
            label: 'Pass assegnato alla sede',
            completed: operations.passAssigned,
            explanation: 'Richiede un profilo Pass attivo assegnato a questa sede.',
            path: '/staff',
          },
          {
            label: 'Cassiere associato a una cassa attiva',
            completed: operations.cashierAssigned,
            explanation:
              'Richiede un cassiere attivo assegnato alla sede e a una postazione cassa attiva.',
            path: '/staff',
          },
        ].map((check) =>
          el(
            'div',
            { class: 'row between' },
            el(
              'div',
              { class: 'stack' },
              el('strong', {}, check.label),
              el('p', { class: 'muted' }, check.explanation),
              status(
                check.completed === null
                  ? 'Richiede Admin di catena'
                  : check.completed
                    ? 'Elemento presente'
                    : 'Da configurare',
              ),
            ),
            check.completed === null
              ? null
              : button('Gestisci', () => context.navigate(check.path), 'secondary'),
          ),
        ),
      ),
      el(
        'section',
        { class: 'card stack' },
        el('h2', {}, 'Personale e collaudo del servizio'),
        el(
          'p',
          { class: 'muted' },
          'La presenza degli elementi non assicura ancora che un cameriere, la cucina, il Pass e la cassa possano completare un servizio. Crea gli account necessari, assegna sedi e ruoli, collega piatti e stazioni e verifica i flussi reali.',
        ),
        button(
          'Personalizza menu e disponibilità per questa sede',
          () => context.navigate('/menu-sede'),
          'secondary',
        ),
        button('Gestisci staff e assegnazioni', () => context.navigate('/staff'), 'secondary'),
        button('Apri centro operativo', () => context.navigate('/operazioni'), 'secondary'),
      ),
    );
  }

  context.refresh = refresh;
  await refresh();
  return view;
}
