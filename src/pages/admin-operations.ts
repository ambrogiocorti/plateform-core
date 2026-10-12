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
      description: 'Richieste clienti da prendere in carico',
      path: '/eccezioni',
      severity: 'warning',
    },
    {
      label: 'Pagamenti pending',
      value: data.cash.pending_payments,
      description: 'Esiti da verificare prima di ripetere incassi',
      path: '/cassa',
      severity: 'warning',
    },
    {
      label: 'Conflitti offline',
      value: data.attention.conflicts,
      description: 'Sincronizzazioni che richiedono decisione',
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
      description: 'Richieste in attesa di approvazione',
      path: '/modifiche',
      severity: 'warning',
    },
    {
      label: 'Incidenti aperti',
      value: data.attention.open_incidents,
      description: 'Problemi operativi non risolti',
      path: '/notifiche',
      severity: 'critical',
    },
    {
      label: 'Notifiche importanti',
      value: data.attention.high_notifications,
      description: 'Priorità incident/critical',
      path: '/notifiche',
      severity: 'warning',
    },
  ];
  const activePriorities = priorities.filter((item) => item.value > 0);

  const attention = el(
    'section',
    { class: 'admin-attention stack' },
    el(
      'div',
      { class: 'row between' },
      el('div', {}, el('p', { class: 'eyebrow' }, 'ADESSO'), el('h2', {}, 'Richiede intervento')),
      el(
        'span',
        { class: 'muted' },
        `Aggiornato ${new Date(data.generated_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`,
      ),
    ),
  );
  if (!activePriorities.length)
    attention.append(
      el(
        'div',
        { class: 'admin-all-clear', role: 'status' },
        el('strong', {}, 'Servizio senza criticità aperte'),
        el('span', {}, 'Continua a monitorare sala, cucina, accoglienza e cassa.'),
      ),
    );
  else
    attention.append(
      el(
        'div',
        { class: 'admin-priority-grid' },
        ...activePriorities.map((item) =>
          el(
            'article',
            { class: `admin-priority ${item.severity ? `is-${item.severity}` : ''}`.trim() },
            el('strong', { class: 'admin-priority-value' }, String(item.value)),
            el('div', {}, el('h3', {}, item.label), el('p', { class: 'muted' }, item.description)),
            button('GESTISCI', () => context.navigate(item.path), 'secondary'),
          ),
        ),
      ),
    );

  const quick = el(
    'nav',
    { class: 'admin-quick-actions', 'aria-label': 'Aree operative' },
    button('AVVIO GUIDATO', () => context.navigate('/preparazione'), 'secondary'),
    button('MENU SEDE', () => context.navigate('/menu-sede'), 'secondary'),
    button('ECCEZIONI', () => context.navigate('/eccezioni'), 'secondary'),
    button('SALA', () => context.navigate('/sala'), 'secondary'),
    button('ACCOGLIENZA', () => context.navigate('/accoglienza'), 'secondary'),
    button('CUCINA', () => context.navigate('/cucina'), 'secondary'),
    button('CASSA', () => context.navigate('/cassa'), 'secondary'),
    button('NOTIFICHE', () => context.navigate('/notifiche'), 'secondary'),
  );

  const areas = el(
    'div',
    { class: 'admin-area-grid' },
    areaCard(
      'Sala',
      `${data.tables.occupied} occupati · ${data.tables.available} liberi`,
      [
        ['Tavoli', data.tables.total],
        ['Conto', data.tables.waiting_bill],
        ['Da riassettare', data.tables.to_reset],
      ],
      () => context.navigate('/sala'),
    ),
    areaCard(
      'Accoglienza',
      `${data.reservations.today} prenotazioni di oggi`,
      [
        ['Da confermare', data.reservations.requested],
        ['Arrivati', data.reservations.arrived],
        ['Accomodati', data.reservations.seated],
      ],
      () => context.navigate('/accoglienza'),
    ),
    areaCard(
      'Cucina',
      `${data.kitchen.active_items} piatti attivi`,
      [
        ['Pronti', data.kitchen.ready],
        ['>10 min', data.kitchen.delayed],
        ['>20 min', data.kitchen.critical],
      ],
      () => context.navigate('/cucina'),
    ),
    areaCard(
      'Cassa',
      `${data.cash.open_registers} casse · ${data.cash.open_services} servizi aperti`,
      [
        ['Pending', data.cash.pending_payments],
        ['Quadrature', data.cash.pending_reconciliations],
        ['Stampe in coda', data.attention.queued_prints],
      ],
      () => context.navigate('/cassa'),
    ),
  );

  return el(
    'div',
    { class: 'stack' },
    el(
      'header',
      { class: 'admin-operations-head' },
      el('div', {}, el('p', { class: 'eyebrow' }, 'SERVIZIO'), el('h1', {}, 'Centro operativo')),
      el('p', { class: 'muted' }, 'Prima le eccezioni. Poi il resto del servizio.'),
    ),
    attention,
    quick,
    areas,
  );
}

function areaCard(
  title: string,
  summary: string,
  metrics: [string, number][],
  open: () => void,
): HTMLElement {
  return el(
    'article',
    { class: 'admin-area-card' },
    el('div', {}, el('h2', {}, title), el('p', { class: 'muted' }, summary)),
    el(
      'div',
      { class: 'admin-area-metrics' },
      ...metrics.map(([label, value]) =>
        el('span', {}, el('strong', {}, String(value)), el('small', {}, label)),
      ),
    ),
    button('APRI', open, 'secondary'),
  );
}
