import { z } from 'zod';
import { button, el, emptyState } from './dom';
import { layoutSchema, layoutTableSchema, renderDrawing, svgElement } from '../room-editor/model';

export const floorTableSchema = layoutTableSchema.extend({
  room_id: z.uuid(),
  layout_id: z.uuid(),
  technical_status: z.string(),
  public_table_id: z.uuid(),
  covers: z.number().int().nonnegative(),
  open_accounts: z.number().int().nonnegative(),
  waiter_name: z.string().nullable(),
  can_open_account: z.boolean().nullable(),
  primary_table_id: z.uuid().nullable(),
});
export type FloorTable = z.infer<typeof floorTableSchema>;
export const floorSchema = z.object({
  rooms: z.array(z.object({ id: z.uuid(), name: z.string(), layout: layoutSchema })),
  tables: z.array(floorTableSchema),
  zones: z.array(z.object({ id: z.uuid(), name: z.string(), color: z.string() })),
  labels: z.array(
    z.object({
      technical_status: z.string(),
      label: z.string(),
      color: z.string(),
      icon: z.string().nullable(),
    }),
  ),
});
export type FloorWorkspace = z.infer<typeof floorSchema>;
export const floorStatusLabels: Record<string, string> = {
  AVAILABLE: 'Disponibile',
  RESERVED: 'Prenotato',
  ARRIVING: 'In arrivo',
  OCCUPIED: 'Occupato',
  ORDERING: 'Ordinazione',
  WAITING_SERVICE: 'In attesa dei piatti',
  WAITING_BILL: 'Conto richiesto',
  PAYMENT: 'Pagamento',
  TO_RESET: 'Da riapparecchiare',
};
const colors: Record<string, string> = {
  AVAILABLE: '#62b996',
  RESERVED: '#8598df',
  ARRIVING: '#dba75d',
  OCCUPIED: '#d17e63',
  ORDERING: '#bd92de',
  WAITING_SERVICE: '#d4bd68',
  WAITING_BILL: '#e88d88',
  PAYMENT: '#89bdd6',
  TO_RESET: '#92979f',
};

export function tableLabel(data: FloorWorkspace, table: FloorTable): string {
  return (
    data.labels.find((label) => label.technical_status === table.technical_status)?.label ??
    floorStatusLabels[table.technical_status] ??
    table.technical_status
  );
}
export function floorView(data: FloorWorkspace, open: (table: FloorTable) => void): HTMLElement {
  if (!data.tables.length)
    return emptyState(
      'La sala prende forma da qui',
      'Attiva un layout e configura i suoi tavoli dal pannello di gestione.',
    );
  const root = el('section', {
    class: 'floor-workspace stack',
    'aria-label': 'Pianta operativa della sala',
  });
  const room = el(
    'select',
    { 'aria-label': 'Sala' },
    el('option', { value: '' }, 'Tutte le sale'),
    ...data.rooms.map((r) => el('option', { value: r.id }, r.name)),
  );
  const zone = el(
    'select',
    { 'aria-label': 'Zona' },
    el('option', { value: '' }, 'Tutte le zone'),
    ...data.zones.map((z) => el('option', { value: z.id }, z.name)),
  );
  const mode = el(
    'select',
    { 'aria-label': 'Vista sala' },
    el('option', { value: 'map' }, 'Pianta'),
    el('option', { value: 'list' }, 'Elenco tavoli'),
  );
  const search = el('input', {
    type: 'search',
    'aria-label': 'Cerca tavolo o cameriere',
    placeholder: 'Nome, numero o cameriere',
    autocomplete: 'off',
  });
  const state = el(
    'select',
    { 'aria-label': 'Stato del tavolo' },
    el('option', { value: '' }, 'Tutti gli stati'),
    ...[...new Set(data.tables.map((table) => table.technical_status))].map((value) => {
      const sample = data.tables.find((table) => table.technical_status === value)!;
      return el('option', { value }, tableLabel(data, sample));
    }),
  );
  const canvas = el('div', { class: 'floor-map-list stack' });
  const summary = el('div', { class: 'floor-summary', 'aria-label': 'Riepilogo tavoli mostrati' });
  const result = el('p', { class: 'floor-result', role: 'status', 'aria-live': 'polite' });
  let zoom = 1;
  const labelFor = (table: FloorTable) =>
    `${table.name} · ${tableLabel(data, table)} · ${table.covers} ospiti · ${table.seats} posti${table.waiter_name ? ` · ${table.waiter_name}` : ''}`;
  const colorFor = (table: FloorTable) => {
    const value = data.labels.find(
      (label) => label.technical_status === table.technical_status,
    )?.color;
    return value && /^#[a-f0-9]{6}$/i.test(value)
      ? value
      : (colors[table.technical_status] ?? '#92979f');
  };
  const normalize = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('it-IT');
  function renderList(tables: FloorTable[]): HTMLElement {
    const grid = el('div', { class: 'floor-grid' });
    for (const table of tables) {
      const tile = button('', () => open(table), 'table-button');
      tile.setAttribute('aria-label', labelFor(table));
      tile.style.borderColor = colorFor(table);
      tile.append(
        el(
          'span',
          { class: 'floor-table-heading' },
          el('strong', { class: 'table-number' }, table.number),
          el('span', { class: 'floor-table-state' }, tableLabel(data, table)),
        ),
        el('span', { class: 'floor-table-name' }, table.name),
        el(
          'span',
          { class: 'muted floor-table-meta' },
          `${table.covers}/${table.seats} ospiti · ${table.open_accounts} conti`,
        ),
      );
      if (table.waiter_name) tile.append(el('span', { class: 'muted' }, table.waiter_name));
      grid.append(tile);
    }
    return grid;
  }
  function draw(): void {
    canvas.replaceChildren();
    const query = normalize(search.value.trim());
    const tables = data.tables.filter(
      (table) =>
        (!room.value || table.room_id === room.value) &&
        (!zone.value || table.zone_id === zone.value) &&
        (!state.value || table.technical_status === state.value) &&
        (!query ||
          normalize(`${table.name} ${table.number} ${table.waiter_name ?? ''}`).includes(query)),
    );
    const metrics: [string, number][] = [
      ['Tavoli mostrati', tables.length],
      ['Disponibili', tables.filter((table) => table.technical_status === 'AVAILABLE').length],
      [
        'Conto richiesto',
        tables.filter((table) => table.technical_status === 'WAITING_BILL').length,
      ],
      [
        'Da riapparecchiare',
        tables.filter((table) => table.technical_status === 'TO_RESET').length,
      ],
    ];
    summary.replaceChildren(
      ...metrics.map(([label, value]) =>
        el('div', { class: 'floor-summary-item' }, el('span', {}, label), el('strong', {}, value)),
      ),
    );
    result.textContent = `${tables.length} ${tables.length === 1 ? 'tavolo mostrato' : 'tavoli mostrati'}`;
    if (!tables.length) {
      canvas.append(
        emptyState('Nessun tavolo in questa selezione', 'Modifica la ricerca o i filtri.'),
      );
      return;
    }
    if (mode.value === 'list') {
      canvas.append(renderList(tables));
      return;
    }
    const mapped = new Set<string>();
    for (const selected of data.rooms.filter((r) => !room.value || r.id === room.value)) {
      const visible = tables.filter((table) => table.layout_id === selected.layout.id);
      if (!visible.length) continue;
      for (const table of visible) mapped.add(table.id);
      const svg = svgElement('svg', {
        viewBox: `0 0 ${selected.layout.width} ${selected.layout.height}`,
        class: 'operational-floor',
        role: 'group',
        'aria-label': `${selected.name} · ${selected.layout.name}`,
      });
      svg.style.width = `${zoom * 100}%`;
      renderDrawing(svg, { elements: selected.layout.elements, tables: visible });
      for (const node of svg.querySelectorAll<SVGGElement>('g[data-id]')) {
        const table = visible.find((t) => t.id === node.dataset.id);
        if (!table) {
          node.removeAttribute('tabindex');
          node.removeAttribute('role');
          node.setAttribute('aria-hidden', 'true');
          continue;
        }
        node.setAttribute('aria-label', labelFor(table));
        node.classList.add('operational-table');
        const shape = node.querySelector('rect,ellipse');
        shape?.setAttribute('fill', '#292d33');
        shape?.setAttribute('stroke', colorFor(table));
        shape?.setAttribute('stroke-width', '6');
        const title = svgElement('title', {});
        title.textContent = labelFor(table);
        node.prepend(title);
        const count = svgElement('text', {
          x: String(table.width / 2),
          y: String(table.height / 2 + 26),
          fill: '#f4f0e8',
          'font-size': '12',
          'text-anchor': 'middle',
        });
        count.textContent = `${table.covers}/${table.seats}`;
        node.append(count);
        const state = svgElement('text', {
          x: String(table.width / 2),
          y: String(table.height + 17),
          fill: '#f4f0e8',
          'font-size': '12',
          'text-anchor': 'middle',
        });
        state.textContent = tableLabel(data, table);
        node.append(state);
        node.addEventListener('click', () => open(table));
        node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open(table);
          }
        });
      }
      canvas.append(
        el(
          'section',
          { class: 'card stack floor-room' },
          el(
            'div',
            { class: 'floor-room-heading' },
            el('h3', {}, selected.name),
            el(
              'span',
              { class: 'muted' },
              `${visible.length} ${visible.length === 1 ? 'tavolo' : 'tavoli'}`,
            ),
          ),
          el(
            'div',
            {
              class: 'floor-map-viewport',
              tabindex: '0',
              'aria-label': `Pianta ${selected.name}, scorrimento orizzontale`,
            },
            svg,
          ),
        ),
      );
    }
    const unmapped = tables.filter((table) => !mapped.has(table.id));
    if (unmapped.length) {
      canvas.append(
        el(
          'section',
          { class: 'card stack floor-unmapped' },
          el('h3', {}, 'Tavoli senza pianta disponibile'),
          el('p', { class: 'muted' }, 'Questi tavoli restano accessibili qui in elenco.'),
          renderList(unmapped),
        ),
      );
    }
  }
  const toolbar = el(
    'div',
    { class: 'row floor-toolbar' },
    el('label', { class: 'floor-search' }, 'Cerca', search),
    el('label', {}, 'Sala', room),
    el('label', {}, 'Zona', zone),
    el('label', {}, 'Stato', state),
    el('label', {}, 'Visualizzazione', mode),
    el(
      'div',
      { class: 'floor-zoom', 'aria-label': 'Dimensione della pianta' },
      button(
        '−',
        () => {
          zoom = Math.max(1, zoom - 0.25);
          draw();
        },
        'secondary',
      ),
      button(
        '+',
        () => {
          zoom = Math.min(3, zoom + 0.25);
          draw();
        },
        'secondary',
      ),
      button(
        'Adatta',
        () => {
          zoom = 1;
          draw();
        },
        'quiet',
      ),
    ),
  );
  toolbar.querySelectorAll('button')[0]?.setAttribute('aria-label', 'Riduci pianta');
  toolbar.querySelectorAll('button')[1]?.setAttribute('aria-label', 'Ingrandisci pianta');
  for (const input of [room, zone, state, mode]) input.addEventListener('change', draw);
  search.addEventListener('input', draw);
  const legend = el('div', { class: 'floor-legend', 'aria-label': 'Legenda degli stati' });
  for (const state of [...new Set(data.tables.map((table) => table.technical_status))]) {
    const sample = data.tables.find((table) => table.technical_status === state)!;
    const label = el('span', { class: 'status' }, tableLabel(data, sample));
    label.style.borderColor = colorFor(sample);
    legend.append(label);
  }
  const clear = button(
    'Azzera filtri',
    () => {
      search.value = '';
      room.value = '';
      zone.value = '';
      state.value = '';
      draw();
    },
    'quiet',
  );
  root.append(
    el(
      'div',
      { class: 'floor-intro' },
      el('div', {}, el('p', { class: 'eyebrow' }, 'PANORAMICA'), el('h2', {}, 'La tua sala')),
      el(
        'p',
        { class: 'muted' },
        'Trova un tavolo e aprilo per gestire le operazioni disponibili.',
      ),
    ),
    summary,
    el(
      'section',
      { class: 'floor-controls', 'aria-label': 'Filtri e visualizzazione' },
      toolbar,
      el('div', { class: 'floor-controls-footer' }, result, clear),
    ),
    legend,
    canvas,
  );
  draw();
  return root;
}
