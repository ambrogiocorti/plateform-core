export type RoomElementKind =
  | 'WALL'
  | 'DOOR'
  | 'WINDOW'
  | 'COUNTER'
  | 'RECTANGLE'
  | 'ELLIPSE'
  | 'DECOR'
  | 'TEXT'
  | 'ZONE';

export interface RuntimeLayoutElement {
  id: string;
  kind: RoomElementKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  text: string;
  color: string;
  layer: number;
}

export interface RuntimeLayoutTable {
  id: string;
  version: number | null;
  name: string;
  number: number;
  seats: number;
  zone_id: string | null;
  shape: 'ROUND' | 'SQUARE' | 'RECTANGLE' | 'OVAL';
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface Drawing {
  elements: RuntimeLayoutElement[];
  tables: RuntimeLayoutTable[];
}

export class History {
  private before: Drawing[] = [];
  private after: Drawing[] = [];
  public current: Drawing;

  constructor(current: Drawing) {
    this.current = structuredClone(current);
  }

  commit(next: Drawing): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.before.push(structuredClone(this.current));
    if (this.before.length > 100) this.before.shift();
    this.current = structuredClone(next);
    this.after = [];
  }

  undo(): void {
    const value = this.before.pop();
    if (value) {
      this.after.push(this.current);
      this.current = value;
    }
  }

  redo(): void {
    const value = this.after.pop();
    if (value) {
      this.before.push(this.current);
      this.current = value;
    }
  }

  get canUndo(): boolean {
    return this.before.length > 0;
  }

  get canRedo(): boolean {
    return this.after.length > 0;
  }
}

export function snapped(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / 10) * 10 : value;
}

export function transformDrawing(
  drawing: Drawing,
  selected: ReadonlySet<string>,
  options: {
    resizeId: string | null;
    dx: number;
    dy: number;
    snap: boolean;
    layoutWidth: number;
    layoutHeight: number;
  },
): Drawing {
  const next = structuredClone(drawing);
  const { resizeId, dx, dy, snap: snapEnabled, layoutWidth, layoutHeight } = options;
  for (const item of next.elements) {
    if (!selected.has(item.id)) continue;
    if (resizeId) {
      if (resizeId !== item.id) continue;
      const maxWidth = Math.max(20, layoutWidth - item.x);
      const maxHeight = Math.max(20, layoutHeight - item.y);
      item.width = Math.min(maxWidth, Math.max(20, snapped(item.width + dx, snapEnabled)));
      item.height = Math.min(maxHeight, Math.max(20, snapped(item.height + dy, snapEnabled)));
      continue;
    }
    item.x = Math.max(0, Math.min(layoutWidth - item.width, snapped(item.x + dx, snapEnabled)));
    item.y = Math.max(0, Math.min(layoutHeight - item.height, snapped(item.y + dy, snapEnabled)));
  }
  for (const table of next.tables) {
    if (!selected.has(table.id)) continue;
    if (resizeId) {
      if (resizeId !== table.id) continue;
      const maxWidth = Math.max(20, layoutWidth - table.position_x);
      const maxHeight = Math.max(20, layoutHeight - table.position_y);
      table.width = Math.min(maxWidth, Math.max(20, snapped(table.width + dx, snapEnabled)));
      table.height = Math.min(maxHeight, Math.max(20, snapped(table.height + dy, snapEnabled)));
      continue;
    }
    table.position_x = Math.max(
      0,
      Math.min(layoutWidth - table.width, snapped(table.position_x + dx, snapEnabled)),
    );
    table.position_y = Math.max(
      0,
      Math.min(layoutHeight - table.height, snapped(table.position_y + dy, snapEnabled)),
    );
  }
  return next;
}
