import assert from 'node:assert/strict';
import { History, transformDrawing } from '../src/room-editor/runtime.ts';

const e1 = 'b9000000-0000-4000-8000-000000000001';
const e2 = 'b9000000-0000-4000-8000-000000000002';
const t1 = 'b9000000-0000-4000-8000-000000000003';
const base = {
  elements: [
    {
      id: e1,
      kind: 'RECTANGLE',
      x: 900,
      y: 700,
      width: 100,
      height: 100,
      rotation: 0,
      text: '',
      color: '#b88a55',
      layer: 0,
    },
    {
      id: e2,
      kind: 'TEXT',
      x: 100,
      y: 100,
      width: 120,
      height: 60,
      rotation: 0,
      text: 'Secondo',
      color: '#111315',
      layer: 1,
    },
  ],
  tables: [
    {
      id: t1,
      version: 1,
      name: 'Tavolo 1',
      number: 1,
      seats: 4,
      zone_id: null,
      shape: 'ROUND',
      position_x: 850,
      position_y: 650,
      width: 100,
      height: 100,
      rotation: 0,
    },
  ],
};

const resized = transformDrawing(base, new Set([e1, e2]), {
  resizeId: e1,
  dx: 500,
  dy: 500,
  snap: true,
  layoutWidth: 1000,
  layoutHeight: 800,
});
assert.equal(resized.elements[0].width, 100, 'resize is clamped to remaining room width');
assert.equal(resized.elements[0].height, 100, 'resize is clamped to remaining room height');
assert.deepEqual(
  resized.elements[1],
  base.elements[1],
  'other selected element does not move during resize',
);

const tableResize = transformDrawing(base, new Set([t1, e2]), {
  resizeId: t1,
  dx: 500,
  dy: 500,
  snap: false,
  layoutWidth: 1000,
  layoutHeight: 800,
});
assert.equal(tableResize.tables[0].width, 150, 'table resize respects right boundary');
assert.equal(tableResize.tables[0].height, 150, 'table resize respects bottom boundary');
assert.deepEqual(
  tableResize.elements[1],
  base.elements[1],
  'element stays fixed while table handle resizes',
);

const moved = transformDrawing(base, new Set([e2, t1]), {
  resizeId: null,
  dx: 1000,
  dy: 1000,
  snap: true,
  layoutWidth: 1000,
  layoutHeight: 800,
});
assert.equal(moved.elements[1].x, 880, 'element move clamps to room width');
assert.equal(moved.elements[1].y, 740, 'element move clamps to room height');
assert.equal(moved.tables[0].position_x, 900, 'table move clamps to room width');
assert.equal(moved.tables[0].position_y, 700, 'table move clamps to room height');

const snappedMove = transformDrawing(base, new Set([e2]), {
  resizeId: null,
  dx: 14,
  dy: 16,
  snap: true,
  layoutWidth: 1000,
  layoutHeight: 800,
});
assert.equal(snappedMove.elements[1].x, 110);
assert.equal(snappedMove.elements[1].y, 120);

const history = new History(base);
history.commit(moved);
assert.equal(history.canUndo, true);
history.undo();
assert.deepEqual(history.current, base, 'undo restores exact drawing');
assert.equal(history.canRedo, true);
history.redo();
assert.deepEqual(history.current, moved, 'redo reapplies exact drawing');

console.log('STEP9_ROOM_EDITOR_RUNTIME_GATE=PASSED');
