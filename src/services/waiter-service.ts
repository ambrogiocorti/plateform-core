export interface WaiterAssignmentSummary {
  mode: 'TABLE' | 'ZONE' | 'RUNNER';
  active: boolean;
}

export interface WaiterTableSummary {
  id: string;
  number: number;
  technical_status: string;
}

export interface WaiterKitchenItemSummary {
  id: string;
  order_id: string;
  step_id: string;
  step_number: number;
  step_status: string;
  table_name: string;
  table_number: number;
  dish_name: string;
  quantity: number;
  created_at: string;
  can_deliver: boolean;
}

export interface WaiterStepSummary {
  id: string;
  orderId: string;
  stepNumber: number;
  status: string;
  tableName: string;
  tableNumber: number;
  createdAt: string;
  canDeliver: boolean;
  items: WaiterKitchenItemSummary[];
}

const tablePriority: Record<string, number> = {
  WAITING_BILL: 0,
  WAITING_SERVICE: 1,
  ORDERING: 2,
  OCCUPIED: 3,
  PAYMENT: 4,
  TO_RESET: 5,
  ARRIVING: 6,
  RESERVED: 7,
  AVAILABLE: 8,
};

export function sortWaiterTables<T extends WaiterTableSummary>(tables: readonly T[]): T[] {
  return [...tables].sort(
    (left, right) =>
      (tablePriority[left.technical_status] ?? 50) -
        (tablePriority[right.technical_status] ?? 50) || left.number - right.number,
  );
}

export function isRunnerOnly(
  assignments: readonly WaiterAssignmentSummary[],
  assignedTableCount: number,
): boolean {
  return assignments.some((assignment) => assignment.active && assignment.mode === 'RUNNER') && assignedTableCount === 0;
}

export function groupWaiterSteps<T extends WaiterKitchenItemSummary>(items: readonly T[]): WaiterStepSummary[] {
  const grouped = new Map<string, WaiterStepSummary>();
  for (const item of items) {
    const existing = grouped.get(item.step_id);
    if (existing) {
      existing.items.push(item);
      existing.canDeliver ||= item.can_deliver;
      continue;
    }
    grouped.set(item.step_id, {
      id: item.step_id,
      orderId: item.order_id,
      stepNumber: item.step_number,
      status: item.step_status,
      tableName: item.table_name,
      tableNumber: item.table_number,
      createdAt: item.created_at,
      canDeliver: item.can_deliver,
      items: [item],
    });
  }
  return [...grouped.values()].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.tableNumber - right.tableNumber,
  );
}
