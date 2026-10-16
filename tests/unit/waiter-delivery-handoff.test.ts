import { describe, expect, it } from 'vitest';
import { waiterDeliveryAction } from '../../src/services/waiter-service';

const ready = { id: 'step-ready', status: 'READY', canDeliver: true };

describe('waiter READY handoff', () => {
  it('requires claim before exposing delivery confirmation', () => {
    expect(waiterDeliveryAction(ready, new Set())).toBe('CLAIM');
    expect(waiterDeliveryAction(ready, new Set([ready.id]))).toBe('CONFIRM_SERVED');
  });

  it('does not let an unassigned waiter claim or serve another table', () => {
    expect(waiterDeliveryAction({ ...ready, canDeliver: false }, new Set())).toBe('NONE');
    expect(waiterDeliveryAction({ ...ready, canDeliver: false }, new Set([ready.id]))).toBe('NONE');
  });

  it('never offers a second delivery for non-READY steps', () => {
    for (const state of ['RECEIVED', 'IN_PREPARATION', 'SERVED', 'CANCELLED']) {
      expect(waiterDeliveryAction({ ...ready, status: state }, new Set([ready.id]))).toBe('NONE');
    }
  });

  it('keeps claim state bound to the exact step identity', () => {
    expect(waiterDeliveryAction(ready, new Set(['other-step']))).toBe('CLAIM');
  });
});
