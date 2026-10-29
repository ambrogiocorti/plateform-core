import { reservationEditor } from './reservation-editor';
import { floorPage } from './floor';
import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, emptyState, field, showError, status, toast } from '../components/dom';
import { stateMachines } from '../services/state-machine';
import type { StaffContext } from './staff-context';
import { command } from './staff-context';
import { environment } from '../config/environment';
import { waitlistOfferFragment } from '../services/waitlist';

const reservationStatus = z.enum([
  'REQUESTED',
  'RESERVED',
  'ARRIVED',
  'SEATED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
]);
const reservationSchema = z.object({
  id: z.uuid(),
  version: z.number(),
  first_name: z.string(),
  last_name: z.string(),
  phone: z.string(),
  party_size: z.number(),
  slot_time: z.string(),
  status: reservationStatus,
  table_id: z.uuid().nullable(),
  table_name: z.string().nullable(),
  service_name: z.string(),
  internal_note: z.string().nullable(),
  customer_note: z.string().nullable(),
  allergies: z.string().nullable(),
  special_occasion: z.string().nullable().optional(),
  walk_in: z.boolean(),
});
type Reservation = z.infer<typeof reservationSchema>;
const labels: Record<Reservation['status'], string> = {
  REQUESTED: 'Da confermare',
  RESERVED: 'Prenotato',
  ARRIVED: 'Arrivato',
  SEATED: 'Accomodato',
  COMPLETED: 'Completato',
  NO_SHOW: 'Non presentato',
  CANCELLED: 'Annullato',
};
const actions: Partial<Record<Reservation['status'], string>> = {
  RESERVED: 'CONFERMA',
  ARRIVED: 'ARRIVO',
  SEATED: 'ACCOMODA',
  COMPLETED: 'COMPLETA',
  NO_SHOW: 'NO-SHOW',
  CANCELLED: 'ANNULLA',
};
const suggestionsSchema = z.array(
  z.object({
    id: z.uuid(),
    table_ids: z.array(z.uuid()),
    name: z.string(),
    seats: z.number(),
    zone_id: z.uuid().nullable(),
    requires_merge: z.boolean(),
  }),
);

export async function hostPage(context: StaffContext): Promise<HTMLElement> {
  const venue = context.venue;
  if (!venue)
    return emptyState('Nessuna sede assegnata', 'Configura una sede per gestire l’accoglienza.');
  // Capture immutable identifiers before entering asynchronous callbacks.
  const venueId = venue.id;
  const venueName = venue.name;

  const services = await readRows(
    'services',
    z.object({ id: z.uuid(), name: z.string(), active: z.boolean() }),
    venue.id,
  );
  const zones = await readRows('zones', z.object({ id: z.uuid(), name: z.string() }), venue.id);
  const activeServices = services.filter((entry) => entry.active);

  const date = field('Giorno', 'date', 'date');
  date.input.required = true;
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: venue.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts();
  date.input.value = ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');

  const service = el(
    'select',
    { 'aria-label': 'Servizio prenotazioni' },
    el('option', { value: '' }, 'Tutti i servizi'),
    ...activeServices.map((entry) => el('option', { value: entry.id }, entry.name)),
  );
  const state = el(
    'select',
    { 'aria-label': 'Stato prenotazione' },
    el('option', { value: '' }, 'Tutti gli stati'),
    ...reservationStatus.options.map((value) => el('option', { value }, labels[value])),
  );
  const search = field('Cerca nome o telefono', 'search', 'search');
  search.input.maxLength = 100;

  const list = el('div', { class: 'stack host-arrivals' });
  const filteredSummary = el('p', { role: 'status', class: 'muted' });
  const kpis = el('div', { class: 'host-service-kpis' });
  let cursor: { time: string; id: string } | null = null;
  let request = 0;
  const more = button('Carica altre prenotazioni', async () => refresh(true), 'secondary');
  more.hidden = true;

  const transition = async (entry: Reservation, next: Reservation['status']): Promise<void> => {
    await command('transition_reservation', {
      p_reservation: entry.id,
      p_status: next,
      p_version: entry.version,
    });
    await context.refresh?.();
  };

  const chooseTable = async (entry: Reservation): Promise<void> => {
    const suggestions = await rpc('suggest_tables', { p_reservation: entry.id }, suggestionsSchema);
    const choices = dialog(
      entry.table_id ? 'Cambia tavolo' : 'Assegna tavolo',
      el(
        'p',
        { class: 'muted' },
        'La disponibilità viene verificata nuovamente al momento dell’assegnazione.',
      ),
    );
    if (!suggestions.length) {
      choices.append(
        emptyState(
          'Nessun tavolo disponibile',
          'Controlla la mappa sala, le capienze e le unioni possibili.',
        ),
      );
      return;
    }
    for (const proposal of suggestions) {
      const zone = proposal.zone_id
        ? zones.find((entry) => entry.id === proposal.zone_id)?.name
        : null;
      choices.append(
        button(
          `${proposal.name} · ${proposal.seats} posti${zone ? ` · ${zone}` : ''}${proposal.requires_merge ? ' · UNIONE' : ''}`,
          async () => {
            if (entry.table_id) {
              const confirmation = dialog(
                'Conferma cambio tavolo',
                el('p', {}, `${entry.table_name ?? 'Non assegnato'} → ${proposal.name}`),
              );
              confirmation.append(
                button('CONFERMA CAMBIO', async () => {
                  await command('assign_table_group', {
                    p_reservation: entry.id,
                    p_tables: [
                      proposal.id,
                      ...proposal.table_ids.filter((id) => id !== proposal.id),
                    ],
                    p_confirm_change: true,
                    p_version: entry.version,
                  });
                  confirmation.close();
                  choices.close();
                  await context.refresh?.();
                }),
              );
              return;
            }
            await command('assign_table_group', {
              p_reservation: entry.id,
              p_tables: [proposal.id, ...proposal.table_ids.filter((id) => id !== proposal.id)],
              p_confirm_change: false,
              p_version: entry.version,
            });
            choices.close();
            toast(`Tavolo assegnato: ${proposal.name}`);
            await context.refresh?.();
          },
          'secondary',
        ),
      );
    }
  };

  const detailDialog = (entry: Reservation): void => {
    const popup = dialog(
      `${entry.first_name} ${entry.last_name}`.trim(),
      el(
        'p',
        {},
        `${entry.slot_time.slice(0, 5)} · ${entry.party_size} persone · ${entry.service_name}`,
      ),
      status(labels[entry.status]),
      el('p', {}, entry.table_name ? `Tavolo: ${entry.table_name}` : 'Tavolo da assegnare'),
      entry.phone ? el('a', { href: `tel:${entry.phone}` }, entry.phone) : null,
      entry.customer_note ? el('p', {}, `Nota cliente: ${entry.customer_note}`) : null,
      entry.allergies ? el('p', {}, `Allergie: ${entry.allergies}`) : null,
      entry.special_occasion ? el('p', {}, `Occasione speciale: ${entry.special_occasion}`) : null,
    );

    if (!entry.walk_in && ['REQUESTED', 'RESERVED', 'ARRIVED'].includes(entry.status))
      popup.append(
        button(
          'Modifica prenotazione',
          async () => {
            popup.close();
            await reservationEditor(context, date.input.value, entry.id);
          },
          'secondary',
        ),
      );
    if (['REQUESTED', 'RESERVED', 'ARRIVED'].includes(entry.status))
      popup.append(
        button(
          entry.table_id ? 'Cambia tavolo' : 'Assegna tavolo',
          () => chooseTable(entry),
          'secondary',
        ),
      );

    const note = field('Nota interna', 'note', 'text', entry.internal_note ?? '');
    note.input.maxLength = 2000;
    const allergies = field('Allergie comunicate', 'allergies', 'text', entry.allergies ?? '');
    allergies.input.maxLength = 2000;
    popup.append(
      note.root,
      allergies.root,
      button(
        'Salva note',
        async () => {
          await command('update_reservation_notes', {
            p_reservation: entry.id,
            p_note: note.input.value,
            p_allergies: allergies.input.value,
            p_version: entry.version,
          });
          popup.close();
          await context.refresh?.();
        },
        'secondary',
      ),
    );

    for (const next of stateMachines.reservation[entry.status].filter((value) =>
      ['CANCELLED', 'NO_SHOW'].includes(value),
    ))
      popup.append(
        button(
          actions[next] ?? labels[next],
          () => {
            const confirmation = dialog(
              actions[next] ?? labels[next],
              el('p', {}, `${entry.first_name} ${entry.last_name} · ${entry.party_size} persone`),
            );
            confirmation.append(
              button(
                'CONFERMA',
                async () => {
                  await transition(entry, next);
                  confirmation.close();
                  popup.close();
                },
                'danger',
              ),
            );
          },
          'danger',
        ),
      );
  };

  const card = (entry: Reservation): HTMLElement => {
    const primary = el('div', { class: 'host-card-actions' });
    if (entry.status === 'REQUESTED')
      primary.append(button('CONFERMA', () => transition(entry, 'RESERVED')));
    if (entry.status === 'RESERVED')
      primary.append(button('ARRIVO', () => transition(entry, 'ARRIVED')));
    if (entry.status === 'ARRIVED' && !entry.table_id)
      primary.append(button('ASSEGNA TAVOLO', () => chooseTable(entry)));
    if (entry.status === 'ARRIVED' && entry.table_id)
      primary.append(button('ACCOMODA', () => transition(entry, 'SEATED')));
    if (entry.status === 'SEATED')
      primary.append(button('COMPLETA', () => transition(entry, 'COMPLETED'), 'secondary'));
    primary.append(button('Dettagli', () => detailDialog(entry), 'quiet'));

    return el(
      'article',
      { class: `card host-arrival-card is-${entry.status.toLowerCase()}` },
      el(
        'div',
        { class: 'host-arrival-main' },
        el(
          'div',
          {},
          el(
            'p',
            { class: 'eyebrow' },
            `${entry.slot_time.slice(0, 5)} · ${entry.service_name}${entry.walk_in ? ' · WALK-IN' : ''}`,
          ),
          el('h2', {}, `${entry.first_name} ${entry.last_name}`.trim() || 'Walk-in'),
          el(
            'p',
            { class: 'host-arrival-meta' },
            `${entry.party_size} persone · ${entry.table_name ?? 'TAVOLO DA ASSEGNARE'}`,
          ),
          entry.allergies
            ? el('p', { class: 'host-alert-line' }, `ALLERGIE · ${entry.allergies}`)
            : null,
        ),
        status(labels[entry.status]),
      ),
      primary,
    );
  };

  async function refresh(append = false): Promise<void> {
    if (!date.input.reportValidity()) return;
    const revision = ++request;
    if (!append) cursor = null;
    const result = await rpc(
      'get_host_reservations',
      {
        p_venue: venueId,
        p_date: date.input.value,
        p_service: service.value || null,
        p_status: state.value || null,
        p_search: search.input.value.trim(),
        p_after_time: cursor?.time ?? null,
        p_after_id: cursor?.id ?? null,
        p_limit: 50,
      },
      z.object({
        items: z.array(reservationSchema),
        has_more: z.boolean(),
        total: z.number(),
        covers: z.number(),
        arrived: z.number(),
        requested: z.number(),
      }),
    );
    if (revision !== request) return;
    if (!append) list.replaceChildren();
    for (const entry of result.items) list.append(card(entry));
    if (!result.total)
      list.append(emptyState('Nessun arrivo', 'Cambia i filtri o registra un walk-in.'));
    const last = result.items.at(-1);
    cursor = last ? { time: last.slot_time, id: last.id } : null;
    more.hidden = !result.has_more;
    filteredSummary.textContent = `${result.total} risultati · ${result.covers} coperti`;
    kpis.replaceChildren(
      el(
        'article',
        { class: 'host-kpi' },
        el('strong', {}, String(result.arrived)),
        el('span', {}, 'ARRIVATI'),
      ),
      el(
        'article',
        { class: 'host-kpi' },
        el('strong', {}, String(result.requested)),
        el('span', {}, 'DA CONFERMARE'),
      ),
      el(
        'article',
        { class: 'host-kpi' },
        el('strong', {}, String(result.total)),
        el('span', {}, 'NELLA LISTA'),
      ),
      el(
        'article',
        { class: 'host-kpi' },
        el('strong', {}, String(result.covers)),
        el('span', {}, 'COPERTI'),
      ),
    );
  }

  const walkInName = field('Nome gruppo', 'walk-in-name');
  walkInName.input.maxLength = 100;
  const walkInCovers = field('Persone', 'walk-in-covers', 'number', '2');
  walkInCovers.input.min = '1';
  walkInCovers.input.max = '1000';
  walkInCovers.input.required = true;
  const walkInService = el(
    'select',
    { 'aria-label': 'Servizio walk-in' },
    ...activeServices.map((entry) => el('option', { value: entry.id }, entry.name)),
  );
  const walkInKey = () => crypto.randomUUID();
  let currentWalkInKey = walkInKey();
  const quickWalkIn = el(
    'section',
    { class: 'card host-quick-form' },
    el(
      'div',
      {},
      el('p', { class: 'eyebrow' }, 'ARRIVO SENZA PRENOTAZIONE'),
      el('h2', {}, 'Walk-in rapido'),
    ),
    walkInName.root,
    walkInCovers.root,
    el('label', { class: 'field' }, 'Servizio', walkInService),
    button('REGISTRA ARRIVO', async () => {
      if (!walkInCovers.input.reportValidity() || !walkInService.value) return;
      await rpc(
        'create_walk_in',
        {
          p_venue: venueId,
          p_service: walkInService.value,
          p_party: Number(walkInCovers.input.value),
          p_name: walkInName.input.value,
          p_key: currentWalkInKey,
        },
        z.object({ id: z.uuid() }),
      );
      currentWalkInKey = walkInKey();
      walkInName.input.value = '';
      walkInCovers.input.value = '2';
      toast('Walk-in registrato. Puoi assegnare subito il tavolo.');
      await context.refresh?.();
    }),
  );

  const filters = el(
    'form',
    { class: 'card host-filters' },
    date.root,
    el('label', { class: 'field' }, 'Servizio', service),
    el('label', { class: 'field' }, 'Stato', state),
    search.root,
    el('button', { type: 'submit', class: 'button secondary' }, 'FILTRA'),
  );
  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    void refresh().catch(showError);
  });

  const reservations = el(
    'section',
    { class: 'host-reservations stack' },
    kpis,
    quickWalkIn,
    el(
      'div',
      { class: 'row between' },
      el('div', {}, el('h2', {}, 'Arrivi e prenotazioni'), filteredSummary),
      button('Nuova prenotazione', () => reservationEditor(context, date.input.value), 'secondary'),
    ),
    filters,
    list,
    more,
  );

  const waitlistService = el(
    'select',
    { 'aria-label': 'Servizio lista d’attesa' },
    ...activeServices.map((entry) => el('option', { value: entry.id }, entry.name)),
  );
  const waitlistTime = field('Orario da proporre', 'waitlist-offer-time', 'time', '19:00');
  waitlistTime.input.required = true;
  const waitlistResults = el('div', { class: 'stack' });
  const waitlistNotice = el('p', { role: 'status', class: 'muted' });
  const candidateSchema = z.object({
    venue_id: z.uuid(),
    service_id: z.uuid(),
    service_date: z.iso.date(),
    proposed_time: z.string(),
    capacity: z.unknown(),
    candidates: z.array(
      z.object({
        id: z.uuid(),
        party_size: z.number(),
        customer_name: z.string(),
        preferred_start_time: z.string(),
        preferred_end_time: z.string().nullable(),
        compatibility_distance_minutes: z.number(),
        created_at: z.string(),
      }),
    ),
  });
  const offerSchema = z.object({
    entry_id: z.uuid(),
    status: z.literal('OFFERED'),
    offered_time: z.string(),
    expires_at: z.string(),
    access_token: z.string().min(32),
  });
  const waitlistPanel = el(
    'section',
    { class: 'card stack host-waitlist' },
    el('p', { class: 'eyebrow' }, 'Accoglienza'),
    el('h2', {}, 'Lista d’attesa'),
    el(
      'p',
      { class: 'muted' },
      'Il server ordina le richieste compatibili e verifica capienza e priorità prima di proporre un posto.',
    ),
    el('label', {}, 'Servizio', waitlistService),
    waitlistTime.root,
    button(
      'Trova richieste compatibili',
      async () => {
        waitlistResults.replaceChildren();
        waitlistNotice.textContent = 'Verifica disponibilità e priorità in corso…';
        const result = await rpc(
          'get_waitlist_candidates',
          {
            p_venue: venueId,
            p_service: waitlistService.value,
            p_date: date.input.value,
            p_time: waitlistTime.input.value,
            p_limit: 50,
          },
          candidateSchema,
        );
        if (
          result.venue_id !== venueId ||
          result.service_id !== waitlistService.value ||
          result.service_date !== date.input.value
        )
          throw new Error('INVALID_WAITLIST_CONTEXT');
        waitlistNotice.textContent = result.candidates.length
          ? `${result.candidates.length} richieste compatibili. La priorità viene verificata ancora al momento dell’offerta.`
          : 'Nessuna richiesta compatibile o nessuna capienza disponibile.';
        for (const candidate of result.candidates) {
          const action = button(
            'Proponi posto',
            async () => {
              const confirmation = dialog(
                'Conferma proposta',
                el(
                  'p',
                  {},
                  `${candidate.customer_name} · ${candidate.party_size} persone · ${date.input.value} alle ${waitlistTime.input.value}`,
                ),
                el(
                  'p',
                  { class: 'muted' },
                  'Il cliente avrà 15 minuti per accettare. L’offerta non è una prenotazione.',
                ),
              );
              const key = crypto.randomUUID();
              confirmation.append(
                button('CONFERMA OFFERTA', async () => {
                  const offerTime = waitlistTime.input.value;
                  const result = await rpc(
                    'offer_waitlist_slot',
                    {
                      p_entry: candidate.id,
                      p_time: offerTime,
                      p_offer_minutes: 15,
                      p_key: key,
                    },
                    offerSchema,
                  );
                  if (result.entry_id !== candidate.id) throw new Error('INVALID_WAITLIST_CONTEXT');
                  confirmation.close();
                  action.disabled = true;
                  const offerLink = new URL('lista-attesa/offerta', environment().publicBaseUrl);
                  offerLink.hash = waitlistOfferFragment(result.entry_id, result.access_token);
                  waitlistResults.prepend(
                    el(
                      'div',
                      { class: 'card stack' },
                      el(
                        'p',
                        { role: 'status' },
                        `Offerta creata per ${candidate.customer_name}. Scadenza: ${new Date(result.expires_at).toLocaleString('it-IT')}.`,
                      ),
                      el(
                        'p',
                        { class: 'muted' },
                        'Invia il collegamento riservato al cliente su un canale verificato. Non condividerlo in una chat di gruppo.',
                      ),
                      button(
                        'Copia collegamento riservato',
                        async () => {
                          await navigator.clipboard.writeText(offerLink.href);
                          toast(
                            'Collegamento copiato. Contiene un token privato: invialo solo al destinatario.',
                          );
                        },
                        'secondary',
                      ),
                    ),
                  );
                  await refresh();
                }),
              );
            },
            'secondary',
          );
          waitlistResults.append(
            el(
              'article',
              { class: 'card row between' },
              el(
                'div',
                {},
                el('strong', {}, candidate.customer_name),
                el(
                  'p',
                  { class: 'muted' },
                  `${candidate.party_size} persone · ${candidate.preferred_start_time.slice(0, 5)}${candidate.preferred_end_time ? `–${candidate.preferred_end_time.slice(0, 5)}` : ''}`,
                ),
              ),
              action,
            ),
          );
        }
      },
      'secondary',
    ),
    waitlistNotice,
    waitlistResults,
  );
  waitlistPanel.id = 'host-waitlist';

  const map = el('section', { class: 'stack host-floor' }, el('h2', {}, 'Sala in servizio'));
  async function refreshFloor(): Promise<void> {
    try {
      map.replaceChildren(
        el(
          'div',
          { class: 'row between' },
          el('h2', {}, 'Sala in servizio'),
          el('span', { class: 'muted' }, venueName),
        ),
        await floorPage(context),
      );
    } catch (error) {
      map.replaceChildren(
        el('h2', {}, 'Sala in servizio'),
        emptyState('Pianta non disponibile', 'Aggiorna la sala per recuperare i dati.'),
        button('Riprova', refreshFloor, 'secondary'),
      );
      showError(error);
    }
  }

  context.refresh = async () => {
    await Promise.all([refresh(), refreshFloor()]);
  };
  await Promise.all([refresh(), refreshFloor()]);
  reservations.id = 'host-arrivals';
  map.id = 'host-floor';
  const overview = el(
    'header',
    { class: 'host-desk-header' },
    el(
      'div',
      {},
      el('p', { class: 'eyebrow' }, 'FRONT DESK · OGGI'),
      el('h2', {}, 'Accoglienza e sala, in un unico posto'),
      el(
        'p',
        { class: 'muted' },
        'Controlla gli arrivi, assegna i tavoli e gestisci la lista d’attesa.',
      ),
    ),
    button('Nuova prenotazione', () => reservationEditor(context, date.input.value)),
  );
  return el(
    'div',
    { class: 'host-workspace host-dashboard-v2' },
    overview,
    kpis,
    el(
      'nav',
      { class: 'host-desk-tabs', 'aria-label': 'Aree accoglienza' },
      el('a', { href: '#host-arrivals' }, 'Arrivi e prenotazioni'),
      el('a', { href: '#host-floor' }, 'Sala'),
      el('a', { href: '#host-waitlist' }, 'Lista d’attesa'),
    ),
    el('div', { class: 'host-desk-body' }, reservations, map),
    waitlistPanel,
  );
}
