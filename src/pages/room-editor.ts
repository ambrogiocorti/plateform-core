import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, el, emptyState, field, toast } from '../components/dom';
import {
  History,
  layoutSchema,
  layoutTableSchema,
  renderDrawing,
  snapped,
  transformDrawing,
  svgElement,
} from '../room-editor/model';
import type { Drawing, LayoutElement } from '../room-editor/model';
import type { StaffContext } from './staff-context';
export async function roomEditorPage(context: StaffContext): Promise<HTMLElement> {
  const layouts = await readRows('room_layouts', layoutSchema, context.venue?.id, {
    archived: 'false',
  });
  const requested = new URLSearchParams(location.search).get('layout');
  const selectedLayout = layouts.find((l) => l.id === requested) ?? layouts[0];
  if (!selectedLayout)
    return emptyState(
      'Aggiungi una sala e un layout',
      'La planimetria sarà modificabile dopo la configurazione della sala.',
    );
  const layout = selectedLayout;
  const tables = await readRows('tables', layoutTableSchema, context.venue?.id, {
    layout_id: layout.id,
    active: 'true',
  });
  const zones = await readRows(
    'zones',
    z.object({ id: z.uuid(), name: z.string() }),
    context.venue?.id,
    { room_id: layout.room_id, active: 'true' },
  );
  let currentLayout = layout;
  const history = new History({ elements: layout.elements, tables });
  const selected = new Set<string>();
  let tool = 'SELECT',
    snap = true,
    zoom = 1,
    panX = 0,
    panY = 0;
  const picker = el(
    'select',
    { 'aria-label': 'Layout' },
    ...layouts.map((l) => el('option', { value: l.id }, l.name + (l.active ? ' · Attivo' : ''))),
  );
  picker.value = layout.id;
  picker.addEventListener('change', () => context.navigate(`/editor?layout=${picker.value}`));
  const svg = svgElement('svg', {
    class: 'room-canvas',
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    tabindex: '0',
    'aria-label': 'Editor della sala',
  });
  const inspector = el('section', {
    class: 'card stack inspector',
    'aria-label': 'Proprietà selezione',
  });
  const count = el('p', { role: 'status' });
  const view = el('div', { class: 'stack' }, el('div', { class: 'row' }, picker, count));
  const tools = el('div', {
    class: 'row editor-tools',
    role: 'toolbar',
    'aria-label': 'Strumenti disegno',
  });
  const names: Record<string, string> = {
    SELECT: 'Seleziona',
    PAN: 'Sposta vista',
    TABLE: 'Tavolo',
    WALL: 'Muro',
    DOOR: 'Porta',
    WINDOW: 'Finestra',
    COUNTER: 'Bancone',
    RECTANGLE: 'Rettangolo',
    ELLIPSE: 'Ellisse',
    DECOR: 'Decorazione',
    TEXT: 'Testo',
    ZONE: 'Zona',
  };
  for (const [kind, label] of Object.entries(names))
    tools.append(
      button(
        label,
        () => {
          tool = kind;
          for (const b of tools.querySelectorAll('button'))
            b.setAttribute('aria-pressed', String(b.textContent === label));
        },
        'secondary',
      ),
    );
  const undo = button(
      'Annulla',
      () => {
        history.undo();
        draw();
      },
      'secondary',
    ),
    redo = button(
      'Ripeti',
      () => {
        history.redo();
        draw();
      },
      'secondary',
    );
  const grid = el('input', { type: 'checkbox' });
  grid.checked = true;
  grid.addEventListener('change', () => {
    snap = grid.checked;
  });
  tools.append(
    undo,
    redo,
    el('label', {}, grid, 'Snap'),
    button(
      'Riduci vista',
      () => {
        zoom = Math.max(0.25, zoom - 0.25);
        draw();
      },
      'quiet',
    ),
    button(
      'Ingrandisci vista',
      () => {
        zoom = Math.min(4, zoom + 0.25);
        draw();
      },
      'quiet',
    ),
  );
  function updateInspector(): void {
    inspector.replaceChildren(
      el('h3', {}, selected.size ? `Selezione: ${selected.size}` : 'Proprietà'),
    );
    const id = [...selected][0],
      element = history.current.elements.find((e) => e.id === id),
      table = history.current.tables.find((t) => t.id === id);
    if (selected.size !== 1 || (!element && !table)) return;
    const name = field(element ? 'Testo' : 'Nome', 'name', 'text', element?.text ?? table!.name);
    const fields = ['x', 'y', 'width', 'height', 'rotation'].map((key) => {
      const value =
        key === 'x'
          ? (element?.x ?? table!.position_x)
          : key === 'y'
            ? (element?.y ?? table!.position_y)
            : key === 'width'
              ? (element?.width ?? table!.width)
              : key === 'height'
                ? (element?.height ?? table!.height)
                : (element?.rotation ?? table!.rotation);
      const f = field(
        (
          {
            x: 'X',
            y: 'Y',
            width: 'Larghezza',
            height: 'Altezza',
            rotation: 'Rotazione',
          } as Record<string, string>
        )[key]!,
        key,
        'number',
        String(value),
      );
      f.input.step = '1';
      return { key, ...f };
    });
    const number = field('Numero tavolo', 'number', 'number', String(table?.number ?? 1));
    const seats = field('Posti', 'seats', 'number', String(table?.seats ?? 2));
    number.input.min = '1';
    seats.input.min = '1';
    seats.input.max = '1000';
    const shape = el(
      'select',
      { 'aria-label': 'Forma tavolo' },
      ...['ROUND', 'SQUARE', 'RECTANGLE', 'OVAL'].map((v) =>
        el(
          'option',
          { value: v },
          (
            {
              ROUND: 'Rotondo',
              SQUARE: 'Quadrato',
              RECTANGLE: 'Rettangolare',
              OVAL: 'Ovale',
            } as Record<string, string>
          )[v]!,
        ),
      ),
    );
    shape.value = table?.shape ?? 'ROUND';
    const zone = el(
      'select',
      { 'aria-label': 'Zona tavolo' },
      el('option', { value: '' }, 'Nessuna zona'),
      ...zones.map((z) => el('option', { value: z.id }, z.name)),
    );
    zone.value = table?.zone_id ?? '';
    const color = field('Colore', 'color', 'color', element?.color ?? '#b88a55');
    inspector.append(name.root, ...fields.map((f) => f.root));
    if (table) inspector.append(number.root, seats.root, shape, zone);
    else inspector.append(color.root);
    inspector.append(
      button(
        'Applica proprietà',
        () => {
          if ([...inspector.querySelectorAll('input')].some((i) => !i.reportValidity())) return;
          const next = structuredClone(history.current);
          const e = next.elements.find((v) => v.id === id),
            t = next.tables.find((v) => v.id === id);
          if (e) {
            e.text = name.input.value;
            e.color = color.input.value;
          }
          if (t) {
            t.name = name.input.value;
            t.number = Number(number.input.value);
            t.seats = Number(seats.input.value);
            t.shape = layoutTableSchema.shape.shape.parse(shape.value);
            t.zone_id = zone.value || null;
          }
          for (const f of fields) {
            const value = Number(f.input.value);
            if (!Number.isFinite(value)) return;
            if (e) {
              if (f.key === 'x') e.x = value;
              else if (f.key === 'y') e.y = value;
              else if (f.key === 'width') e.width = value;
              else if (f.key === 'height') e.height = value;
              else e.rotation = value;
            }
            if (t) {
              if (f.key === 'x') t.position_x = value;
              else if (f.key === 'y') t.position_y = value;
              else if (f.key === 'width') t.width = value;
              else if (f.key === 'height') t.height = value;
              else t.rotation = value;
            }
          }
          history.commit(next);
          draw();
        },
        'secondary',
      ),
    );
  }
  function draw(): void {
    svg.setAttribute('viewBox', `${panX} ${panY} ${layout.width / zoom} ${layout.height / zoom}`);
    renderDrawing(svg, history.current, selected);
    count.textContent = `${history.current.tables.length} tavoli · Zoom ${Math.round(zoom * 100)}%`;
    undo.disabled = !history.canUndo;
    redo.disabled = !history.canRedo;
    updateInspector();
  }
  function point(event: PointerEvent): { x: number; y: number } {
    const p = new DOMPoint(event.clientX, event.clientY);
    const matrix = svg.getScreenCTM();
    return matrix ? p.matrixTransform(matrix.inverse()) : { x: 0, y: 0 };
  }
  let drag: {
    start: { x: number; y: number };
    drawing: Drawing;
    resize: string | null;
    pan: boolean;
    originalPan: { x: number; y: number };
  } | null = null;
  svg.addEventListener('pointerdown', (event) => {
    const p = point(event);
    const target = event.target instanceof Element ? event.target : null;
    const id = target?.closest('[data-id]')?.getAttribute('data-id');
    const resize = target?.getAttribute('data-resize') ?? null;
    if (tool === 'PAN') {
      drag = {
        start: p,
        drawing: structuredClone(history.current),
        resize: null,
        pan: true,
        originalPan: { x: panX, y: panY },
      };
      svg.setPointerCapture(event.pointerId);
      return;
    }
    if (resize || id) {
      const chosen = resize ?? id!;
      if (!event.shiftKey && !selected.has(chosen)) selected.clear();
      if (event.shiftKey && selected.has(chosen)) selected.delete(chosen);
      else selected.add(chosen);
      drag = {
        start: p,
        drawing: structuredClone(history.current),
        resize,
        pan: false,
        originalPan: { x: panX, y: panY },
      };
      draw();
      svg.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'SELECT') {
      selected.clear();
      draw();
      return;
    }
    const next = structuredClone(history.current);
    const fresh = crypto.randomUUID();
    if (tool === 'TABLE') {
      const number = Math.max(0, ...next.tables.map((t) => t.number)) + 1;
      next.tables.push({
        id: fresh,
        version: null,
        name: `Tavolo ${number}`,
        number,
        seats: 4,
        zone_id: null,
        shape: 'ROUND',
        position_x: snapped(p.x, snap),
        position_y: snapped(p.y, snap),
        width: 90,
        height: 90,
        rotation: 0,
      });
    } else
      next.elements.push({
        id: fresh,
        kind: tool as LayoutElement['kind'],
        x: snapped(p.x, snap),
        y: snapped(p.y, snap),
        width: tool === 'WALL' ? 200 : 140,
        height: ['WALL', 'WINDOW', 'DOOR'].includes(tool) ? 16 : 80,
        rotation: 0,
        text: tool === 'TEXT' ? 'Testo' : '',
        color: tool === 'WALL' ? '#747474' : '#b88a55',
        layer: next.elements.length,
      });
    history.commit(next);
    selected.clear();
    selected.add(fresh);
    tool = 'SELECT';
    draw();
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const p = point(event),
      dx = p.x - drag.start.x,
      dy = p.y - drag.start.y;
    if (drag.pan) {
      panX = Math.max(0, drag.originalPan.x - dx);
      panY = Math.max(0, drag.originalPan.y - dy);
      draw();
      return;
    }
    const next = transformDrawing(drag.drawing, selected, {
      resizeId: drag.resize,
      dx,
      dy,
      snap,
      layoutWidth: layout.width,
      layoutHeight: layout.height,
    });
    renderDrawing(svg, next, selected);
  });
  function endDrag(event: PointerEvent, cancelled = false): void {
    if (!drag) return;
    const original = drag;
    drag = null;
    if (!original.pan && !cancelled) {
      const p = point(event),
        dx = p.x - original.start.x,
        dy = p.y - original.start.y;
      history.commit(
        transformDrawing(original.drawing, selected, {
          resizeId: original.resize,
          dx,
          dy,
          snap,
          layoutWidth: layout.width,
          layoutHeight: layout.height,
        }),
      );
    }
    draw();
  }
  svg.addEventListener('pointerup', (event) => endDrag(event));
  svg.addEventListener('pointercancel', (event) => endDrag(event, true));
  function remove(): void {
    const next = structuredClone(history.current);
    next.elements = next.elements.filter((i) => !selected.has(i.id));
    next.tables = next.tables.filter((t) => !selected.has(t.id));
    history.commit(next);
    selected.clear();
    draw();
  }
  function duplicate(): void {
    const next = structuredClone(history.current);
    const ids = new Set<string>();
    for (const e of history.current.elements.filter((e) => selected.has(e.id))) {
      const c = {
        ...e,
        id: crypto.randomUUID(),
        x: Math.min(layout.width - e.width, e.x + 20),
        y: Math.min(layout.height - e.height, e.y + 20),
        layer: next.elements.length,
      };
      next.elements.push(c);
      ids.add(c.id);
    }
    for (const t of history.current.tables.filter((t) => selected.has(t.id))) {
      const n = Math.max(0, ...next.tables.map((t) => t.number)) + 1,
        c = {
          ...t,
          id: crypto.randomUUID(),
          version: null,
          number: n,
          name: `Tavolo ${n}`,
          position_x: Math.min(layout.width - t.width, t.position_x + 20),
          position_y: Math.min(layout.height - t.height, t.position_y + 20),
        };
      next.tables.push(c);
      ids.add(c.id);
    }
    history.commit(next);
    selected.clear();
    ids.forEach((id) => selected.add(id));
    draw();
  }
  tools.append(
    button('Duplica', duplicate, 'secondary'),
    button('Elimina selezione', remove, 'quiet'),
    button(
      'Porta avanti',
      () => {
        const next = structuredClone(history.current);
        next.elements
          .filter((e) => selected.has(e.id))
          .forEach((e) => (e.layer = Math.min(10000, e.layer + 1)));
        history.commit(next);
        draw();
      },
      'quiet',
    ),
    button(
      'Porta indietro',
      () => {
        const next = structuredClone(history.current);
        next.elements
          .filter((e) => selected.has(e.id))
          .forEach((e) => (e.layer = Math.max(-10000, e.layer - 1)));
        history.commit(next);
        draw();
      },
      'quiet',
    ),
  );
  view.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) history.redo();
      else history.undo();
      draw();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicate();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      history.current.elements.forEach((e) => selected.add(e.id));
      history.current.tables.forEach((t) => selected.add(t.id));
      draw();
    }
  });
  let saveKey = crypto.randomUUID(),
    savePayload: Drawing | null = null;
  tools.append(
    button('Salva layout', async () => {
      if (!savePayload) {
        savePayload = structuredClone(history.current);
      }
      const result = await rpc(
        'save_room_layout',
        {
          p_layout: layout.id,
          p_version: currentLayout.version,
          p_elements: savePayload.elements,
          p_tables: savePayload.tables,
          p_key: saveKey,
        },
        z.object({ layout: layoutSchema, tables: z.array(layoutTableSchema) }),
      );
      currentLayout = result.layout;
      history.current = { elements: result.layout.elements, tables: result.tables };
      savePayload = null;
      saveKey = crypto.randomUUID();
      toast('Layout salvato.');
      draw();
    }),
    button(
      'Attiva layout',
      async () => {
        await rpc(
          'activate_room_layout',
          { p_layout: layout.id, p_version: currentLayout.version, p_key: crypto.randomUUID() },
          z.object({ id: z.uuid() }),
        );
        toast('Layout attivato.');
        await context.refresh?.();
      },
      'secondary',
    ),
  );
  view.append(
    tools,
    el('div', { class: 'editor-grid' }, el('div', { class: 'canvas-scroll' }, svg), inspector),
  );
  draw();
  return view;
}
