import { z } from 'zod';
import { vaultGet, vaultPut } from './vault';
export { clearOffline, vaultGet, vaultPut } from './vault';
import { offlineWorkspaceKey, offlineWorkspaceSchema } from './workspace';
import { predecessorFor } from './queue-policy';
import {
  authorizationSchema,
  offlineVerificationKeys,
  verifyOfflineAuthorization,
} from './authorization';
export { authorizationSchema, claimsSchema } from './authorization';
export async function offlineAuthorization() {
  const authorization = await vaultGet('authorization', authorizationSchema);
  if (!authorization) return undefined;
  try {
    const now = Date.now();
    const high = (await vaultGet('clock', z.number())) ?? 0;
    const claims = await verifyOfflineAuthorization(
      authorization,
      offlineVerificationKeys(),
      now,
      high,
    );
    if (!claims) return undefined;
    await vaultPut('clock', Math.max(now, high));
    return { authorization, claims };
  } catch {
    return undefined;
  }
}
const queueBase = z.object({
  client_event_id: z.uuid(),
  idempotency_key: z.uuid(),
  authorization_id: z.uuid(),
  created_at_local: z.string(),
  user_id: z.uuid(),
  device_id: z.uuid(),
  venue_id: z.uuid(),
  resource_id: z.uuid(),
  base_version: z.number().int().positive(),
  predecessor_id: z.uuid().nullable(),
  sync_status: z.enum(['PENDING', 'SYNCING', 'SYNCED', 'CONFLICT', 'REJECTED', 'RESOLVED']),
  result: z.unknown().optional(),
});
export const queueEventSchema = z.discriminatedUnion('operation', [
  queueBase.extend({
    resource_type: z.literal('accounts'),
    operation: z.literal('CREATE_ORDER'),
    payload: z.object({ items: z.array(z.unknown()) }).strict(),
  }),
  queueBase.extend({
    resource_type: z.literal('order_steps'),
    operation: z.literal('START_STEP'),
    payload: z.object({}).strict(),
  }),
  queueBase.extend({
    resource_type: z.literal('tables'),
    operation: z.literal('SET_TABLE_AVAILABLE'),
    payload: z.object({}).strict(),
  }),
]);
export type QueueEvent = z.infer<typeof queueEventSchema>;
export async function queuedEvents(): Promise<QueueEvent[]> {
  return (await vaultGet('queue', z.array(queueEventSchema))) ?? [];
}
export async function enqueueOrder(
  venue: string,
  account: string,
  version: number,
  items: unknown[],
): Promise<QueueEvent> {
  return enqueueOperation(venue, account, version, 'CREATE_ORDER', { items });
}
export async function enqueueStep(
  venue: string,
  step: string,
  version: number,
): Promise<QueueEvent> {
  return enqueueOperation(venue, step, version, 'START_STEP', {});
}
export async function enqueueTableReset(
  venue: string,
  table: string,
  version: number,
): Promise<QueueEvent> {
  return enqueueOperation(venue, table, version, 'SET_TABLE_AVAILABLE', {});
}
async function enqueueOperation(
  venue: string,
  resource: string,
  version: number,
  operation: QueueEvent['operation'],
  payload: unknown,
): Promise<QueueEvent> {
  if (!navigator.locks) throw new Error('OFFLINE_BROWSER_UNSUPPORTED');
  return navigator.locks.request('plateform-offline-queue', async () => {
    const verified = await offlineAuthorization();
    if (!verified || !verified.claims.venue_ids.includes(venue))
      throw new Error('OFFLINE_AUTHORIZATION_EXPIRED');
    const workspace = await vaultGet(
      offlineWorkspaceKey(verified.claims.user_id, venue),
      offlineWorkspaceSchema,
    );
    const role = verified.claims.role;
    const authorized =
      operation === 'CREATE_ORDER'
        ? role === 'WAITER' &&
          workspace?.accounts.some((row) => row.id === resource && row.version === version)
        : operation === 'START_STEP'
          ? ['WAITER', 'PASS', 'KITCHEN_ADMIN'].includes(role) &&
            workspace?.steps.some(
              (row) => row.id === resource && row.version === version && row.can_start,
            )
          : ['ADMIN', 'HOST', 'WAITER'].includes(role) &&
            workspace?.reset_tables.some((row) => row.id === resource && row.version === version);
    if (!authorized) throw new Error('OFFLINE_OPERATION_FORBIDDEN');
    const queue = await queuedEvents();
    if (queue.filter((event) => event.authorization_id === verified.authorization.id).length >= 500)
      throw new Error('OFFLINE_QUEUE_LIMIT');
    if (
      queue.some(
        (event) =>
          event.user_id !== verified.claims.user_id &&
          !['SYNCED', 'REJECTED', 'RESOLVED'].includes(event.sync_status),
      )
    )
      throw new Error('OFFLINE_OTHER_USER_QUEUE');
    if (
      queue.some(
        (e) =>
          e.resource_id === resource && !['SYNCED', 'REJECTED', 'RESOLVED'].includes(e.sync_status),
      )
    )
      throw new Error('OFFLINE_RESOURCE_ALREADY_QUEUED');
    const event = queueEventSchema.parse({
      client_event_id: crypto.randomUUID(),
      idempotency_key: crypto.randomUUID(),
      authorization_id: verified.authorization.id,
      created_at_local: new Date().toISOString(),
      user_id: verified.claims.user_id,
      device_id: verified.claims.device_id,
      venue_id: venue,
      resource_type:
        operation === 'CREATE_ORDER'
          ? 'accounts'
          : operation === 'START_STEP'
            ? 'order_steps'
            : 'tables',
      resource_id: resource,
      operation,
      base_version: version,
      payload,
      predecessor_id: predecessorFor(queue, {
        user_id: verified.claims.user_id,
        venue_id: venue,
      }),
      sync_status: 'PENDING',
    });
    queue.push(event);
    await vaultPut('queue', queue);
    return event;
  });
}
export async function cachedRpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const verified = name === 'get_public_menu' ? null : await offlineAuthorization();
  if (name !== 'get_public_menu' && !verified) return undefined;
  return await vaultGet(
    `rpc:${verified?.claims.user_id ?? 'public'}:${name}:${JSON.stringify(args)}`,
    schema,
  );
}
export async function cacheRpc(
  name: string,
  args: Record<string, unknown>,
  value: unknown,
): Promise<void> {
  if (!['get_public_menu', 'get_account_workspace'].includes(name)) return;
  const verified = name === 'get_public_menu' ? null : await offlineAuthorization();
  if (name !== 'get_public_menu' && !verified) return;
  await vaultPut(
    `rpc:${verified?.claims.user_id ?? 'public'}:${name}:${JSON.stringify(args)}`,
    value,
  );
}
