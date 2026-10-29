import { z } from 'zod';
import { rpc } from '../api/client';
import { button, el, emptyState } from '../components/dom';
import type { StaffContext } from './staff-context';

const adminOverviewSchema = z.object({
  generated_at: z.string(),
  service_date: z.string(),
  tables: z.object({
    total: z.number().int(),
    available: z.number().int(),
    occupied: z.number().int(),
    waiting_bill: z.number().int(),
    to_reset: z.number().int(),
  }),
  kitchen: z.object({
    active_items: z.number().int(),
    ready: z.number().int(),
    delayed: z.number().int(),
    critical: z.number().int(),
  }),
  reservations: z.object({
    today: z.number().int(),
    requested: z.number().int(),
    arrived: z.number().int(),
    seated: z.number().int(),
  }),
  calls: z.object({ new: z.number().int(), accepted: z.number().int() }),
  cash: z.object({
    open_registers: z.number().int(),
    open_services: z.number().int(),
    pending_payments: z.number().int(),
    pending_reconciliations: z.number().int(),
  }),
  attention: z.object({
    notifications: z.number().int(),
    high_notifications: z.number().int(),
    conflicts: z.number().int(),
    failed_prints: z.number().int(),
    queued_prints: z.number().int(),
    order_changes: z.number().int(),
    open_incidents: z.number().int(),
  }),
});

type AdminOverview = z.infer<typeof adminOverviewSchema>;

type Priority = {
  label: string;
  value: number;
  description: string;
  path: string;
  severity?: 'critical' | 'warning';
};

export async function adminOperationsPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venue)
    return emptyState('Nessuna sede', 'Seleziona una sede autorizzata per vedere il servizio.');

  const root = el('div', { class: 'stack admin-operations' });
  const render = async () => {
    const data = await rpc(
      'get_admin_operational_overview',
      { p_venue: context.venue!.id },
      adminOverviewSchema,
    );
    root.replaceChildren(renderOverview(context, data));
  };
  context.refresh = render;
  await render();
  return root;
}

function renderOverview(context: StaffContext, data: AdminOverview): HTMLElement {
  const updated = new Date(data.generated_at).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const priorities: Priority[] = [
    {
      label: 'Cucina critica',
      value: data.kitchen.critical,
      description: 'Piatti oltre i 20 minuti',
      path: '/cucina',
      severity: 'critical',
    },
    {
      label: 'Chiamate nuove',
      value: data.calls.new,
      description: 'Richieste dei tavoli da gestire',
      path: '/eccezioni',
      severity: 'warning',
    },
    {
      label: 'Pagamenti da verificare',
      value: data.cash.pending_payments,
      description: 'Verifica prima di ripetere un incasso',
      path: '/cassa',
      severity: 'warning',
    },
    {
      label: 'Conflitti offline',
      value: data.attention.conflicts,
      description: 'Sincronizzazioni da risolvere',
      path: '/conflitti',
      severity: 'warning',
    },
    {
      label: 'Stampe fallite',
      value: data.attention.failed_prints,
      description: 'Documenti da riconciliare',
      path: '/stampe',
      severity: 'warning',
    },
    {
      label: 'Modifiche comande',
      value: data.attention.order_changes,
      description: 'Richieste da approvare',
      path: '/modifiche',
      severity: 'warning',
    },
    {
      label: 'Incidenti aperti',
      value: data.attention.open_incidents,
      description: 'Problemi operativi in corso',
      path: '/notifiche',
      severity: 'critical',
    },
    {
      label: 'Notifiche importanti',
      value: data.attention.high_notifications,
      description: 'Comunicazioni urgenti',
      path: '/notifiche',
      severity: 'warning',
    },
  ];
  const active = priorities.filter((item) => item.value > 0);
  const criticalCount = active
    .filter((item) => item.severity === 'critical')
    .reduce((sum, item) => sum + item.value, 0);
  const pendingCount = active.reduce((sum, item) => sum + item.value, 0);

  const overview = el(
    'section',
    { class: 'ops-overview', 'aria-label': 'Panoramica del servizio' },
    el(
      'div',
      { class: 'ops-overview-heading' },
      el('span', { class: 'ops-overline' }, 'IL SERVIZIO · IN TEMPO REALE'),
      el(
        'h2',
        {},
        criticalCount > 0
          ? 'Ci sono priorità da gestire.'
          : pendingCount > 0
            ? 'Il servizio richiede attenzione.'
            : 'Il servizio è sotto controllo.',
      ),
      el('p', {}, 'Una panoramica per sapere cosa sta succedendo, ora.'),
      el(
        'div',
        { class: 'ops-overview-actions' },
        button('Apri la sala', () => context.navigate('/sala')),
        button('Accoglienza', () => context.navigate('/accoglienza'), 'secondary'),
      ),
    ),
    el(
      'div',
      { class: 'ops-overview-score' },
      el('span', { class: 'ops-overview-score-label' }, 'DA GESTIRE'),
      el(
        'strong',
        { class: criticalCount ? 'ops-score-critical' : 'ops-score-clear' },
        String(pendingCount),
      ),
      el(
        'span',
        {},
        criticalCount > 0
          ? String(criticalCount) + ' criticità urgenti'
          : active.length
            ? 'Interventi non urgenti'
            : 'Nessuna criticità aperta',
      ),
    ),
  );

  const metrics = el(
    'section',
    { class: 'ops-summary-grid', 'aria-label': 'Indicatori principali' },
    metric(
      'Tavoli occupati',
      data.tables.occupied,
      String(data.tables.available) + ' liberi',
      'sala',
      () => context.navigate('/sala'),
    ),
    metric(
      'Piatti in cucina',
      data.kitchen.active_items,
      String(data.kitchen.ready) + ' pronti',
      'cucina',
      () => context.navigate('/cucina'),
    ),
    metric(
      'Prenotazioni oggi',
      data.reservations.today,
      String(data.reservations.requested) + ' da confermare',
      'accoglienza',
      () => context.navigate('/accoglienza'),
    ),
    metric(
      'Casse aperte',
      data.cash.open_registers,
      String(data.cash.pending_payments) + ' pagamenti pending',
      'cassa',
      () => context.navigate('/cassa'),
    ),
  );

  const areaList = el(
    'section',
    { class: 'ops-service-card' },
    el(
      'div',
      { class: 'ops-section-head' },
      el(
        'div',
        {},
        el('span', { class: 'ops-overline' }, 'AREE DI LAVORO'),
        el('h2', {}, 'Gestisci il servizio'),
      ),
      el('span', { class: 'ops-inline-note' }, 'Accesso rapido per area'),
    ),
    el(
      'div',
      { class: 'ops-service-grid' },
      serviceArea(
        'Sala',
        'Disponibilità e gestione tavoli',
        [
          ['Occupati', data.tables.occupied],
          ['Liberi', data.tables.available],
          ['Da liberare', data.tables.to_reset],
        ],
        () => context.navigate('/sala'),
      ),
      serviceArea(
        'Cucina',
        'Produzione e tempi delle comande',
        [
          ['Attivi', data.kitchen.active_items],
          ['Pronti', data.kitchen.ready],
          ['In ritardo', data.kitchen.delayed],
        ],
        () => context.navigate('/cucina'),
      ),
      serviceArea(
        'Accoglienza',
        'Prenotazioni, arrivi e lista d’attesa',
        [
          ['Prenotazioni', data.reservations.today],
          ['Arrivati', data.reservations.arrived],
          ['Accomodati', data.reservations.seated],
        ],
        () => context.navigate('/accoglienza'),
      ),
      serviceArea(
        'Cassa',
        'Incassi, quadrature e pagamenti',
        [
          ['Servizi', data.cash.open_services],
          ['Da verificare', data.cash.pending_payments],
          ['Quadrature', data.cash.pending_reconciliations],
        ],
        () => context.navigate('/cassa'),
      ),
    ),
  );

  const urgent = el(
    'aside',
    { class: 'ops-attention-card', 'aria-label': 'Attività da gestire' },
    el(
      'div',
      { class: 'ops-section-head' },
      el(
        'div',
        {},
        el('span', { class: 'ops-overline' }, 'PRIORITÀ'),
        el('h2', {}, 'Da gestire ora'),
      ),
      el(
        'span',
        { class: active.length ? 'ops-attention-count is-active' : 'ops-attention-count' },
        String(active.length),
      ),
    ),
  );
  if (active.length) {
    const ordered = [...active].sort(
      (a, b) =>
        Number(b.severity === 'critical') - Number(a.severity === 'critical') || b.value - a.value,
    );
    urgent.append(
      el(
        'div',
        { class: 'ops-attention-list' },
        ...ordered.map((item) => {
          const action = el(
            'button',
            {
              type: 'button',
              class: 'ops-attention-row' + (item.severity === 'critical' ? ' is-critical' : ''),
              'aria-label':
                item.label + ', ' + item.value + ': ' + item.description + '. Apri l’area',
            },
            el('span', { class: 'ops-attention-dot', 'aria-hidden': 'true' }),
            el(
              'span',
              { class: 'ops-attention-copy' },
              el('strong', {}, item.label),
              el('small', {}, item.description),
            ),
            el('b', {}, String(item.value)),
          );
          action.addEventListener('click', () => context.navigate(item.path));
          return action;
        }),
      ),
    );
  } else {
    urgent.append(
      el(
        'div',
        { class: 'ops-all-clear', role: 'status' },
        el('strong', {}, 'Nessun intervento in attesa'),
        el('p', {}, 'Il servizio non presenta criticità aperte.'),
      ),
    );
  }
  urgent.append(
    el(
      'div',
      { class: 'ops-aside-footer' },
      el('span', {}, 'Aggiornato alle ' + updated),
      button('Centro notifiche', () => context.navigate('/notifiche'), 'secondary'),
    ),
  );

  const utilities = el(
    'section',
    { class: 'ops-utility-strip', 'aria-label': 'Strumenti di gestione' },
    el(
      'div',
      {},
      el('span', { class: 'ops-overline' }, 'STRUMENTI'),
      el('strong', {}, 'Organizza il prossimo servizio'),
    ),
    el(
      'div',
      { class: 'ops-utility-actions' },
      button('Preparazione', () => context.navigate('/preparazione'), 'secondary'),
      button('Menu sede', () => context.navigate('/menu-sede'), 'secondary'),
      context.licensedFeatures?.has('FOOD_COST')
        ? button('Food cost', () => context.navigate('/food-cost'), 'secondary')
        : null,
      button('Stampe', () => context.navigate('/stampe'), 'secondary'),
    ),
  );

  return el(
    'div',
    { class: 'ops-dashboard' },
    el(
      'header',
      { class: 'ops-dashboard-intro' },
      el(
        'div',
        {},
        el('span', { class: 'ops-overline' }, 'CENTRO OPERATIVO · ' + data.service_date),
        el('h1', {}, 'Panoramica del servizio'),
      ),
      el('span', { class: 'ops-update-badge' }, 'Dati aggiornati ' + updated),
    ),
    overview,
    metrics,
    el('div', { class: 'ops-body-grid' }, urgent, areaList),
    utilities,
  );
}

function metric(
  label: string,
  value: number,
  description: string,
  tone: string,
  open: () => void,
): HTMLElement {
  const control = el(
    'button',
    { type: 'button', class: 'ops-metric ops-metric-' + tone },
    el('span', { class: 'ops-metric-label' }, label),
    el('strong', {}, String(value)),
    el('span', { class: 'ops-metric-description' }, description),
    el('span', { class: 'ops-metric-action', 'aria-hidden': 'true' }, '↗'),
  );
  control.addEventListener('click', open);
  return control;
}

function serviceArea(
  title: string,
  description: string,
  metrics: [string, number][],
  open: () => void,
): HTMLElement {
  const card = el(
    'article',
    { class: 'ops-area-tile' },
    el(
      'div',
      { class: 'ops-area-title' },
      el('div', {}, el('h3', {}, title), el('p', {}, description)),
      el('span', { class: 'ops-area-arrow', 'aria-hidden': 'true' }, '↗'),
    ),
    el(
      'dl',
      { class: 'ops-area-stats' },
      ...metrics.map(([label, value]) =>
        el('div', {}, el('dt', {}, label), el('dd', {}, String(value))),
      ),
    ),
  );
  const link = el(
    'button',
    { type: 'button', class: 'ops-area-open', 'aria-label': 'Apri ' + title },
    'Apri area',
  );
  link.addEventListener('click', open);
  card.append(link);
  return card;
}
