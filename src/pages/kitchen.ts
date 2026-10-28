import { z } from 'zod';
import { rpc } from '../api/client';
import { button, dialog, el, emptyState, status } from '../components/dom';
import { command } from './staff-context';
import type { StaffContext } from './staff-context';

const itemSchema = z.object({
  id: z.uuid(),
  order_id: z.uuid(),
  step_id: z.uuid(),
  step_number: z.number(),
  step_status: z.string(),
  table_name: z.string(),
  table_number: z.number(),
  dish_name: z.string(),
  quantity: z.number(),
  status: z.string(),
  station_id: z.uuid(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  version: z.number(),
  can_prepare: z.boolean(),
  can_deliver: z.boolean(),
  removed_ingredients: z.array(z.string()),
  variants: z.array(z.object({ group: z.string(), option: z.string() })),
  allergens: z.array(z.string()),
});

const kitchenAdminOverviewSchema = z.object({
  summary: z.object({
    steps: z.number().int(),
    received: z.number().int(),
    in_preparation: z.number().int(),
    ready: z.number().int(),
    delayed: z.number().int(),
    critical: z.number().int(),
  }),
  stations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      active: z.boolean(),
      received: z.number().int(),
      in_preparation: z.number().int(),
      ready: z.number().int(),
      delayed: z.number().int(),
      critical: z.number().int(),
      oldest_created_at: z.string().nullable(),
    }),
  ),
  returns: z.array(
    z.object({
      id: z.uuid(),
      created_at: z.string(),
      action: z.string(),
      dish_name: z.string(),
      table_name: z.string(),
      step_number: z.number().int(),
    }),
  ),
});

type KitchenAdminOverview = z.infer<typeof kitchenAdminOverviewSchema>;

function kitchenAdminPanel(data: KitchenAdminOverview, board: HTMLElement): HTMLElement {
  const { summary } = data;
  const summaryGrid = el(
    'div',
    { class: 'kitchen-admin-summary' },
    kitchenAdminKpi('STEP ATTIVI', summary.steps),
    kitchenAdminKpi('RICEVUTI', summary.received),
    kitchenAdminKpi('IN PREPARAZIONE', summary.in_preparation),
    kitchenAdminKpi('PRONTI', summary.ready),
    kitchenAdminKpi('RITARDO >10′', summary.delayed, summary.delayed ? 'is-warning' : ''),
    kitchenAdminKpi('CRITICI >20′', summary.critical, summary.critical ? 'is-critical' : ''),
  );

  const stations = el(
    'section',
    { class: 'kitchen-admin-panel stack', 'aria-label': 'Carico per stazione' },
    el(
      'div',
      { class: 'row between' },
      el('div', {}, el('p', { class: 'eyebrow' }, 'COORDINAMENTO'), el('h2', {}, 'Stazioni')),
      button(
        'VAI ALLA KDS',
        () => board.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        'secondary',
      ),
    ),
  );
  if (!data.stations.length)
    stations.append(el('p', { class: 'muted' }, 'Nessuna stazione attiva configurata.'));
  for (const station of data.stations) {
    const severity = station.critical ? 'is-critical' : station.delayed ? 'is-warning' : '';
    stations.append(
      el(
        'article',
        { class: `kitchen-admin-station ${severity}`.trim() },
        el(
          'div',
          {},
          el('h3', {}, station.name),
          el(
            'p',
            { class: 'muted' },
            station.oldest_created_at
              ? `Comanda più vecchia ${elapsedLabel(station.oldest_created_at)}`
              : 'Nessuna comanda attiva',
          ),
        ),
        el(
          'div',
          { class: 'kitchen-admin-station-counts' },
          el('span', {}, `Ricevuti ${station.received}`),
          el('span', {}, `Preparazione ${station.in_preparation}`),
          el('span', {}, `Pronti ${station.ready}`),
          station.delayed ? el('strong', {}, `Ritardi ${station.delayed}`) : null,
          station.critical ? el('strong', {}, `Critici ${station.critical}`) : null,
        ),
      ),
    );
  }

  const returned = el(
    'section',
    { class: 'kitchen-admin-panel stack', 'aria-label': 'Piatti tornati indietro' },
    el('p', { class: 'eyebrow' }, 'PROBLEMI'),
    el('h2', {}, 'Piatti tornati indietro'),
  );
  if (!data.returns.length) returned.append(el('p', { class: 'muted' }, 'Nessun reso recente.'));
  for (const item of data.returns)
    returned.append(
      el(
        'article',
        { class: 'kitchen-admin-return' },
        el(
          'div',
          {},
          el('strong', {}, `${item.table_name} · STEP ${item.step_number}`),
          el('p', {}, item.dish_name),
        ),
        el(
          'div',
          { class: 'kitchen-admin-return-meta' },
          status(item.action),
          el(
            'span',
            { class: 'muted' },
            new Date(item.created_at).toLocaleTimeString('it-IT', {
              hour: '2-digit',
              minute: '2-digit',
            }),
          ),
        ),
      ),
    );

  return el(
    'section',
    { class: 'stack kitchen-admin-overview', 'data-kitchen-admin-overview': 'true' },
    el(
      'header',
      { class: 'kitchen-admin-head' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, 'REGIA CUCINA'),
        el('h1', {}, 'Coordinamento servizio'),
      ),
      el(
        'p',
        { class: 'muted' },
        summary.critical
          ? `${summary.critical} piatti oltre i 20 minuti richiedono intervento.`
          : summary.delayed
            ? `${summary.delayed} piatti oltre i 10 minuti da monitorare.`
            : 'Nessuna criticità di tempo rilevata.',
      ),
    ),
    summaryGrid,
    el('div', { class: 'kitchen-admin-columns' }, stations, returned),
  );
}

function kitchenAdminKpi(label: string, value: number, severity = ''): HTMLElement {
  return el(
    'article',
    { class: `kitchen-admin-kpi ${severity}`.trim() },
    el('span', {}, label),
    el('strong', {}, String(value)),
  );
}

function elapsedLabel(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes < 1) return 'Adesso';
  if (minutes === 1) return '1 min';
  return `${minutes} min`;
}

function urgencyClass(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes >= 20) return 'is-critical';
  if (minutes >= 10) return 'is-warning';
  return 'is-normal';
}

export async function kitchenPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venue)
    return emptyState('Nessuna sede', 'Verifica le assegnazioni del tuo account.');

  const [items, adminOverview] = await Promise.all([
    rpc('get_kitchen_board', { p_venue: context.venue.id }, z.array(itemSchema)),
    context.profile.role === 'KITCHEN_ADMIN'
      ? rpc('get_kitchen_admin_overview', { p_venue: context.venue.id }, kitchenAdminOverviewSchema)
      : Promise.resolve(null),
  ]);

  const steps = [...new Set(items.map((item) => item.step_id))];
  const grid = el('div', {
    class: 'grid kitchen-grid',
    'data-kds-role': context.profile.role,
    id: 'kitchen-operational-board',
  });

  for (const step of steps) {
    const rows = items.filter((item) => item.step_id === step);
    const first = rows[0];
    if (!first) continue;

    const readyCount = rows.filter((item) => item.status === 'READY').length;
    const complete = readyCount === rows.length;
    const card = el(
      'article',
      {
        class: `kds-ticket ${urgencyClass(first.created_at)}${complete ? ' is-complete' : ''}`,
        'data-step-status': first.step_status,
        'data-ticket-states': rows.map((item) => item.status).join(' '),
      },
      el(
        'header',
        { class: 'kds-ticket-head' },
        el(
          'div',
          {},
          el('p', { class: 'eyebrow' }, `TAVOLO ${first.table_number}`),
          el('h2', {}, first.table_name),
        ),
        el(
          'div',
          { class: 'kds-ticket-meta' },
          el('strong', { class: 'kds-timer' }, elapsedLabel(first.created_at)),
          status(first.step_status),
        ),
      ),
      el(
        'div',
        { class: 'kds-step-summary' },
        el('strong', {}, `STEP ${first.step_number}`),
        context.profile.role === 'PASS'
          ? el('span', {}, `${readyCount}/${rows.length} piatti pronti`)
          : el('span', {}, `${rows.length} ${rows.length === 1 ? 'piatto' : 'piatti'}`),
      ),
    );

    for (const item of rows) {
      const modifiers = [
        ...item.removed_ingredients.map((name) => `SENZA ${name}`),
        ...item.variants.map((variant) => `${variant.group}: ${variant.option}`),
      ];
      const line = el(
        'section',
        { class: `kitchen-line kitchen-status-${item.status.toLowerCase()}` },
        el(
          'div',
          { class: 'kitchen-line-main' },
          el('h3', {}, `${item.quantity} × ${item.dish_name}`),
          status(item.status),
        ),
        ...(modifiers.length
          ? [el('p', { class: 'kitchen-modifier' }, modifiers.join(' · '))]
          : []),
        ...(item.allergens.length
          ? [
              el(
                'p',
                { class: 'kitchen-allergens', role: 'note' },
                `ALLERGENI: ${item.allergens.join(' · ')}`,
              ),
            ]
          : []),
      );

      if (
        item.can_prepare &&
        item.step_status === 'ACTIVE' &&
        ['RECEIVED', 'IN_PREPARATION'].includes(item.status)
      ) {
        line.append(
          button(item.status === 'RECEIVED' ? 'RICEVUTO → PREPARA' : 'SEGNA PRONTO', async () => {
            await command('transition_order_item', {
              p_item: item.id,
              p_status: item.status === 'RECEIVED' ? 'IN_PREPARATION' : 'READY',
              p_version: item.version,
            });
            await context.refresh?.();
          }),
        );
      }

      if (['PASS', 'KITCHEN_ADMIN'].includes(context.profile.role) && item.status === 'READY') {
        line.append(
          button(
            'Piatto tornato indietro',
            () => {
              const popup = dialog('Errore ordine', el('p', {}, item.dish_name));
              const key = crypto.randomUUID();
              for (const action of ['REMAKE', 'CANCEL_REQUEST'])
                popup.append(
                  button(
                    action === 'REMAKE' ? 'Rifare il piatto' : 'Richiedi annullamento Admin',
                    async () => {
                      await rpc(
                        'return_order_item',
                        { p_item: item.id, p_action: action, p_version: item.version, p_key: key },
                        z.record(z.string(), z.unknown()),
                      );
                      popup.close();
                      await context.refresh?.();
                    },
                    'secondary',
                  ),
                );
            },
            'quiet',
          ),
        );
      }
      card.append(line);
    }

    if (context.profile.role === 'PASS' && first.step_status === 'ACTIVE' && complete) {
      card.append(
        el('div', { class: 'pass-ready-banner', role: 'status' }, 'PRONTO PER IL SERVIZIO'),
        button('AVVISA E LIBERA LO STEP', async () => {
          await command('mark_step_ready', { p_step: step });
          await context.refresh?.();
        }),
      );
    }

    if (
      ['WAITER', 'PASS', 'KITCHEN_ADMIN'].includes(context.profile.role) &&
      first.step_status === 'WAITING'
    ) {
      card.append(
        button(
          'Avvia step',
          async () => {
            await command('start_order_step', { p_step: step });
            await context.refresh?.();
          },
          'secondary',
        ),
      );
    }

    grid.append(card);
  }

  const board: HTMLElement = items.length
    ? grid
    : emptyState(
        context.profile.role === 'PASS' ? 'Pass libero' : 'Nessuna comanda in attesa',
        context.profile.role === 'PASS'
          ? 'Gli step pronti o in coordinamento compariranno qui in tempo reale.'
          : 'Le comande pertinenti alla tua postazione compariranno qui in tempo reale.',
      );

  const boardShell = el(
    'section',
    { class: 'kds-workspace', 'aria-label': 'Comande in lavorazione' },
    el(
      'header',
      { class: 'kds-workspace-header' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, 'PRODUZIONE · LIVE'),
        el(
          'h2',
          {},
          context.profile.role === 'PASS' ? 'Comande da coordinare' : 'Comande in cucina',
        ),
        el('p', {}, 'Lavora per priorità e concentrati sullo stato di ogni comanda.'),
      ),
      el(
        'div',
        { class: 'kds-overview-strip', role: 'status' },
        el('div', {}, el('strong', {}, String(steps.length)), el('span', {}, 'Step')),
        el(
          'div',
          {},
          el('strong', {}, String(items.filter((item) => item.status === 'RECEIVED').length)),
          el('span', {}, 'Ricevuti'),
        ),
        el(
          'div',
          {},
          el('strong', {}, String(items.filter((item) => item.status === 'IN_PREPARATION').length)),
          el('span', {}, 'In preparazione'),
        ),
        el(
          'div',
          {},
          el('strong', {}, String(items.filter((item) => item.status === 'READY').length)),
          el('span', {}, 'Pronti'),
        ),
      ),
    ),
  );
  if (items.length) {
    const filterActions = el('div', {
      class: 'kds-filter-actions',
      'aria-label': 'Filtra le comande',
    });
    const filters = [
      ['Tutte', 'ALL'],
      ['Da preparare', 'RECEIVED'],
      ['In lavorazione', 'IN_PREPARATION'],
      ['Pronte', 'READY'],
    ];
    for (const [label, value] of filters) {
      const control = button(
        label,
        () => {
          for (const item of grid.querySelectorAll<HTMLElement>('.kds-ticket')) {
            item.hidden =
              value !== 'ALL' && !(item.dataset.ticketStates ?? '').split(' ').includes(value);
          }
          for (const element of filterActions.querySelectorAll<HTMLButtonElement>('button')) {
            element.setAttribute('aria-pressed', String(element === control));
          }
        },
        'secondary',
      );
      control.setAttribute('aria-pressed', String(value === 'ALL'));
      filterActions.append(control);
    }
    boardShell.append(filterActions);
  }
  boardShell.append(board);
  if (!adminOverview) return boardShell;
  return el(
    'div',
    { class: 'stack kitchen-operations-dashboard' },
    kitchenAdminPanel(adminOverview, boardShell),
    boardShell,
  );
}
