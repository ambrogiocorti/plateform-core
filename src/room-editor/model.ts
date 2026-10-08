import { z } from 'zod';
import type { Drawing } from './runtime';
export const elementSchema = z.object({
  id: z.uuid(),
  kind: z.enum([
    'WALL',
    'DOOR',
    'WINDOW',
    'COUNTER',
    'RECTANGLE',
    'ELLIPSE',
    'DECOR',
    'TEXT',
    'ZONE',
  ]),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  rotation: z.number().finite(),
  text: z.string().max(300).default(''),
  color: z.string().regex(/^#[a-f0-9]{6}$/i),
  layer: z.number().int(),
});
export const layoutSchema = z.object({
  id: z.uuid(),
  room_id: z.uuid(),
  name: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  version: z.number().int(),
  active: z.boolean(),
  elements: z.array(elementSchema),
});
export const layoutTableSchema = z.object({
  id: z.uuid(),
  version: z.number().int().nullable().default(null),
  name: z.string(),
  number: z.number().int().positive(),
  seats: z.number().int().positive(),
  zone_id: z.uuid().nullable(),
  shape: z.enum(['ROUND', 'SQUARE', 'RECTANGLE', 'OVAL']),
  position_x: z.coerce.number().finite(),
  position_y: z.coerce.number().finite(),
  width: z.coerce.number().finite(),
  height: z.coerce.number().finite(),
  rotation: z.coerce.number().finite(),
});
export type LayoutElement = z.infer<typeof elementSchema>;
export type LayoutTable = z.infer<typeof layoutTableSchema>;
export { History, snapped, transformDrawing } from './runtime';
export type { Drawing } from './runtime';

export function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
export function renderDrawing(
  svg: SVGSVGElement,
  drawing: Drawing,
  selected: ReadonlySet<string> = new Set(),
): void {
  svg.replaceChildren();
  for (const item of [...drawing.elements].sort((a, b) => a.layer - b.layer)) {
    const g = svgElement('g', {
      'data-id': item.id,
      transform: `translate(${item.x} ${item.y}) rotate(${item.rotation} ${item.width / 2} ${item.height / 2})`,
      tabindex: '0',
      role: 'button',
      'aria-label': item.text || item.kind,
    });
    const shape =
      item.kind === 'ELLIPSE'
        ? svgElement('ellipse', {
            cx: String(item.width / 2),
            cy: String(item.height / 2),
            rx: String(item.width / 2),
            ry: String(item.height / 2),
          })
        : svgElement('rect', {
            width: String(item.width),
            height: String(item.height),
            rx: item.kind === 'COUNTER' ? '8' : '0',
          });
    shape.setAttribute('fill', item.kind === 'TEXT' ? 'transparent' : item.color);
    shape.setAttribute('opacity', item.kind === 'ZONE' ? '0.2' : '1');
    shape.setAttribute('stroke', selected.has(item.id) ? '#f4f0e8' : '#747474');
    shape.setAttribute('stroke-width', selected.has(item.id) ? '4' : '1');
    g.append(shape);
    if (item.text) {
      const text = svgElement('text', {
        x: '8',
        y: '22',
        fill: item.kind === 'TEXT' ? item.color : '#ffffff',
        'font-size': '18',
      });
      text.textContent = item.text;
      g.append(text);
    }
    svg.append(g);
  }
  for (const item of drawing.tables) {
    const g = svgElement('g', {
      'data-id': item.id,
      transform: `translate(${item.position_x} ${item.position_y}) rotate(${item.rotation} ${item.width / 2} ${item.height / 2})`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${item.name}, ${item.seats} posti`,
    });
    const shape = ['ROUND', 'OVAL'].includes(item.shape)
      ? svgElement('ellipse', {
          cx: String(item.width / 2),
          cy: String(item.height / 2),
          rx: String(item.width / 2),
          ry: String(item.height / 2),
        })
      : svgElement('rect', { width: String(item.width), height: String(item.height), rx: '8' });
    shape.setAttribute('fill', '#68523c');
    shape.setAttribute('stroke', selected.has(item.id) ? '#f4f0e8' : '#b88a55');
    shape.setAttribute('stroke-width', selected.has(item.id) ? '4' : '2');
    g.append(shape);
    const text = svgElement('text', {
      x: String(item.width / 2),
      y: String(item.height / 2 + 6),
      'text-anchor': 'middle',
      fill: '#fff',
      'font-size': '20',
    });
    text.textContent = String(item.number);
    g.append(text);
    svg.append(g);
  }
  for (const id of selected) {
    const element = drawing.elements.find((x) => x.id === id);
    const table = drawing.tables.find((x) => x.id === id);
    if (!element && !table) continue;
    const x = element?.x ?? table!.position_x,
      y = element?.y ?? table!.position_y,
      w = element?.width ?? table!.width,
      h = element?.height ?? table!.height;
    svg.append(
      svgElement('rect', {
        'data-resize': id,
        x: String(x + w - 12),
        y: String(y + h - 12),
        width: '24',
        height: '24',
        fill: '#f4f0e8',
        stroke: '#111315',
        cursor: 'nwse-resize',
      }),
    );
  }
}
