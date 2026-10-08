import { z } from 'zod';
import { rpc } from '../api/client';
import { button, el, field } from '../components/dom';
import { formatMoney } from '../services/money';
import type { StaffContext } from './staff-context';
const aggregate = z.object({ amount_cents: z.number().int(), tip_cents: z.number().int() });
const counts = z.object({ reservations: z.number().int(), covers: z.number().int() });
const products = z.object({
  name: z.string(),
  quantity: z.number().int(),
  amount_cents: z.number().int(),
});
const statisticsSchema = z.object({
  receipts_cents: z.number().int(),
  refunds_cents: z.number().int(),
  reversals_cents: z.number().int(),
  net_cents: z.number().int(),
  tips_cents: z.number().int(),
  covers: z.number().int(),
  reservations: z.number().int(),
  preparation_seconds: z.number().nullable(),
  daily: z.array(aggregate.extend({ local_date: z.string() })),
  methods: z.array(aggregate.extend({ method: z.string(), entries: z.number().int() })),
  venues: z.array(aggregate.extend({ id: z.uuid(), name: z.string() })),
  products: z.array(products),
  categories: z.array(products),
  closed_accounts: z.number().int(),
  average_check_cents: z.number().int().nullable(),
  no_shows: z.number().int(),
  no_show_percent: z.number().nullable(),
  cancelled_reservations: z.number().int(),
  walk_ins: z.number().int(),
  booking_states: z.array(counts.extend({ status: z.string() })),
  booking_slots: z.array(counts.extend({ slot_time: z.string() })),
  returns: z.number().int(),
  calls: z.number().int(),
  call_acceptance_seconds: z.number().nullable(),
  call_completion_seconds: z.number().nullable(),
  stations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      items: z.number().int(),
      preparation_seconds: z.number().nullable(),
      delivery_seconds: z.number().nullable(),
    }),
  ),
  registers: z.array(aggregate.extend({ id: z.uuid(), name: z.string() })),
  services: z.array(aggregate.extend({ name: z.string() })),
  average_stay_seconds: z.number().nullable(),
  cancelled_items: z.number().int(),
  operational_errors: z.number().int(),
  incidents: z.number().int(),
  open_incidents: z.number().int(),
  capacity_services: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      capacity_covers: z.number().int().nullable(),
      used_covers: z.number().int(),
      utilization_percent: z.number().nullable(),
    }),
  ),
});
const duration = (seconds: number | null) =>
  seconds === null
    ? 'Non disponibile'
    : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
const methodNames: Record<string, string> = {
  CASH: 'Contanti',
  CARD_POS: 'POS esterno',
  STRIPE: 'Stripe',
  SATISPAY_POS: 'Satispay POS',
  SATISPAY_API: 'Satispay online',
};
const bookingNames: Record<string, string> = {
  REQUESTED: 'Da confermare',
  RESERVED: 'Prenotati',
  ARRIVED: 'Arrivati',
  SEATED: 'Accomodati',
  COMPLETED: 'Completati',
  NO_SHOW: 'Non presentati',
  CANCELLED: 'Annullati',
};

export async function statisticsPage(context: StaffContext): Promise<HTMLElement> {
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone: context.venue?.timezone ?? 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format();
  const start = field('Dal giorno', 'start', 'date', today.slice(0, 8) + '01'),
    end = field('Al giorno', 'end', 'date', today);
  start.input.required = true;
  end.input.required = true;
  const scope = el(
    'select',
    { 'aria-label': 'Ambito statistiche' },
    ...context.venues.map((venue) => el('option', { value: venue.id }, venue.name)),
    context.profile.scope === 'CHAIN' && context.multiVenue
      ? el('option', { value: '' }, 'Tutte le sedi autorizzate')
      : null,
  );
  scope.value = context.venue?.id ?? '';
  const result = el('div', { class: 'stack' });
  let snapshot: z.infer<typeof statisticsSchema> | null = null;
  let snapshotDates: { start: string; end: string; scope: string } | null = null;
  const exportButton = button(
    'Esporta report CSV',
    () => {
      if (!snapshot || !snapshotDates) return;
      const rows: (string | number)[][] = [
        ['Periodo', snapshotDates.start, snapshotDates.end],
        ['Ambito', snapshotDates.scope],
        ['Metriche', 'Valore'],
        ['Incassi centesimi', snapshot.receipts_cents],
        ['Rimborsi centesimi', snapshot.refunds_cents],
        ['Storni centesimi', snapshot.reversals_cents],
        ['Movimenti netti centesimi', snapshot.net_cents],
        ['Mance centesimi', snapshot.tips_cents],
        ['Coperti', snapshot.covers],
        ['Conti chiusi', snapshot.closed_accounts],
        ['Conto medio centesimi', snapshot.average_check_cents ?? ''],
        ['No-show', snapshot.no_shows],
        ['Chiamate', snapshot.calls],
        ['Resi', snapshot.returns],
        ['Permanenza media secondi', snapshot.average_stay_seconds ?? ''],
        ['Piatti annullati', snapshot.cancelled_items],
        ['Errori operativi', snapshot.operational_errors],
        ['Incidenti', snapshot.incidents],
        ['Incidenti aperti', snapshot.open_incidents],
        [],
        ['Giorno', 'Movimenti centesimi', 'Mance centesimi'],
        ...snapshot.daily.map((row) => [row.local_date, row.amount_cents, row.tip_cents]),
        [],
        ['Categoria', 'Quantità', 'Addebiti centesimi'],
        ...snapshot.categories.map((row) => [row.name, row.quantity, row.amount_cents]),
        [],
        ['Metodo', 'Movimenti centesimi', 'Mance centesimi'],
        ...snapshot.methods.map((row) => [row.method, row.amount_cents, row.tip_cents]),
      ];
      const cell = (value: string | number) => {
        const text = String(value);
        return `"${(typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
      };
      const url = URL.createObjectURL(
        new Blob(['\uFEFF' + rows.map((row) => row.map(cell).join(';')).join('\r\n')], {
          type: 'text/csv;charset=utf-8',
        }),
      );
      const link = el('a', {
        href: url,
        download: `plateform-report-${snapshotDates.start}-${snapshotDates.end}.csv`,
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    'secondary',
  );
  exportButton.disabled = true;
  async function load(): Promise<void> {
    if (!start.input.reportValidity() || !end.input.reportValidity()) return;
    const data = await rpc(
      'get_operational_statistics',
      { p_venue: scope.value || null, p_start: start.input.value, p_end: end.input.value },
      statisticsSchema,
    );
    snapshot = data;
    snapshotDates = {
      start: start.input.value,
      end: end.input.value,
      scope: scope.selectedOptions[0]?.textContent ?? '',
    };
    exportButton.disabled = false;
    result.replaceChildren(
      el(
        'div',
        { class: 'kpi-grid' },
        ...[
          ['Incassi', data.receipts_cents],
          ['Rimborsi', data.refunds_cents],
          ['Storni', data.reversals_cents],
          ['Movimenti netti', data.net_cents],
          ['Mance separate', data.tips_cents],
        ].map(([name, amount]) =>
          el(
            'section',
            { class: 'card' },
            el('h2', {}, String(name)),
            el('p', { class: 'amount' }, formatMoney(Number(amount))),
          ),
        ),
      ),
      el(
        'div',
        { class: 'kpi-grid' },
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'Coperti accolti'),
          el('p', { class: 'amount' }, data.covers),
        ),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'Conto medio'),
          el(
            'p',
            { class: 'amount' },
            data.average_check_cents === null
              ? 'Non disponibile'
              : formatMoney(data.average_check_cents),
          ),
          el('p', {}, `${data.closed_accounts} conti chiusi nel periodo`),
        ),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'No-show'),
          el('p', { class: 'amount' }, data.no_shows),
          el(
            'p',
            {},
            data.no_show_percent === null
              ? 'Nessuna prenotazione confermata nel periodo'
              : `${data.no_show_percent}% delle prenotazioni confermate`,
          ),
        ),
      ),
    );
    const maximum = Math.max(1, ...data.daily.map((day) => Math.abs(day.amount_cents))),
      chart = el('section', { class: 'card stack' }, el('h2', {}, 'Movimenti giornalieri'));
    for (const day of data.daily)
      chart.append(
        el(
          'div',
          { class: 'row' },
          el('span', {}, day.local_date),
          el('meter', {
            min: '0',
            max: String(maximum),
            value: String(Math.abs(day.amount_cents)),
            'aria-label': `Movimenti ${day.local_date}: ${formatMoney(day.amount_cents)}`,
          }),
          el('strong', {}, formatMoney(day.amount_cents)),
        ),
      );
    if (!data.daily.length)
      chart.append(el('p', {}, 'Nessun movimento contabile registrato nel periodo.'));
    result.append(chart);
    const groups = [
      [
        'Metodi di pagamento',
        data.methods.map((row) => ({
          name: methodNames[row.method] ?? row.method,
          amount: row.amount_cents,
          detail: `${row.entries} movimenti · Mance ${formatMoney(row.tip_cents)}`,
        })),
      ],
      [
        'Sedi',
        data.venues.map((row) => ({
          name: row.name,
          amount: row.amount_cents,
          detail: `Mance ${formatMoney(row.tip_cents)}`,
        })),
      ],
      [
        'Casse',
        data.registers.map((row) => ({
          name: row.name,
          amount: row.amount_cents,
          detail: `Mance ${formatMoney(row.tip_cents)}`,
        })),
      ],
      [
        'Servizi',
        data.services.map((row) => ({
          name: row.name,
          amount: row.amount_cents,
          detail: `Mance ${formatMoney(row.tip_cents)}`,
        })),
      ],
      [
        'Categorie ordinate',
        data.categories.map((row) => ({
          name: row.name,
          amount: row.amount_cents,
          detail: `${row.quantity} porzioni`,
        })),
      ],
      [
        'Prodotti ordinati',
        data.products.map((row) => ({
          name: row.name,
          amount: row.amount_cents,
          detail: `${row.quantity} porzioni`,
        })),
      ],
    ] as const;
    for (const [title, rows] of groups) {
      const section = el('section', { class: 'card stack' }, el('h2', {}, title));
      for (const row of rows)
        section.append(
          el(
            'div',
            { class: 'row between' },
            el('span', {}, `${row.name} · ${row.detail}`),
            el('strong', {}, formatMoney(row.amount)),
          ),
        );
      if (!rows.length) section.append(el('p', {}, 'Nessun dato nel periodo.'));
      result.append(section);
    }
    const bookings = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Prenotazioni e walk-in'),
      el(
        'p',
        {},
        `${data.reservations} prenotazioni attive o completate · ${data.cancelled_reservations} annullate · ${data.walk_ins} walk-in`,
      ),
    );
    for (const row of data.booking_states)
      bookings.append(
        el(
          'p',
          {},
          `${bookingNames[row.status] ?? row.status}: ${row.reservations} gruppi · ${row.covers} coperti`,
        ),
      );
    bookings.append(el('h3', {}, 'Distribuzione degli arrivi'));
    for (const row of data.booking_slots)
      bookings.append(
        el(
          'p',
          {},
          `${row.slot_time.slice(0, 5)} · ${row.reservations} gruppi · ${row.covers} coperti`,
        ),
      );
    if (data.capacity_services.length) bookings.append(el('h3', {}, 'Utilizzo capacità servizi'));
    for (const service of data.capacity_services)
      bookings.append(
        el(
          'p',
          {},
          service.capacity_covers === null
            ? `${service.name} · ${service.used_covers} coperti · capacità non configurata`
            : `${service.name} · ${service.used_covers}/${service.capacity_covers} coperti · ${service.utilization_percent ?? 0}%`,
        ),
      );
    const operations = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Cucina, consegne e chiamate'),
      el('p', {}, `Preparazione media: ${duration(data.preparation_seconds)}`),
      el('p', {}, `Permanenza media al tavolo: ${duration(data.average_stay_seconds)}`),
      el('p', {}, `${data.returns} resi · ${data.cancelled_items} piatti annullati · ${data.calls} chiamate clienti`),
      el('p', {}, `${data.operational_errors} errori operativi · ${data.incidents} incidenti nel periodo · ${data.open_incidents} incidenti aperti`),
      el(
        'p',
        {},
        `Presa in carico chiamate: ${duration(data.call_acceptance_seconds)} · Completamento: ${duration(data.call_completion_seconds)}`,
      ),
    );
    for (const station of data.stations)
      operations.append(
        el(
          'p',
          {},
          `${station.name} · ${station.items} righe comanda · Preparazione ${duration(station.preparation_seconds)} · Da pronto a servito ${duration(station.delivery_seconds)}`,
        ),
      );
    result.append(bookings, operations);
  }
  const view = el(
    'div',
    { class: 'stack' },
    el(
      'div',
      { class: 'card row' },
      start.root,
      end.root,
      scope,
      button('Aggiorna statistiche', load),
      exportButton,
    ),
    el(
      'p',
      { class: 'muted' },
      'Le date seguono il fuso di ciascuna sede. Incassi, rimborsi e storni seguono il giorno del movimento; le mance restano separate. Le categorie riportano gli addebiti delle comande del periodo. Il conto medio usa gli addebiti dei conti chiusi, inclusi i conti divisi.',
    ),
    result,
  );
  await load();
  return view;
}
