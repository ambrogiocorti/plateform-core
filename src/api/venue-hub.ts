import { z } from 'zod';
import { isLanRpc, LAN_TABLES } from '../../shared/lan-contract';

// Staff-side link to the venue hub (ADR-0001). When this device is paired with
// a hub, the operations in shared/lan-contract.ts are sent to the hub, which is
// the venue's single write authority, also while the cloud is reachable.
// The pairing token is a device credential (like a session): it is kept only
// in this browser profile and never placed in URLs, QR codes or logs.

const STORAGE_KEY = 'plateform-venue-hub';
const linkSchema = z.object({
  url: z.string(),
  token: z.string().min(32).max(256),
  label: z.string().max(80).optional(),
});
export type HubLink = z.infer<typeof linkSchema>;

// HTTPS is required in production. Plain HTTP is accepted only for loopback,
// used by local development and automated tests on the same machine.
export function normalizeHubUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

let cached: HubLink | null | undefined;
export function hubLink(): HubLink | null {
  if (cached !== undefined) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? linkSchema.safeParse(JSON.parse(raw)) : null;
    cached =
      parsed?.success && normalizeHubUrl(parsed.data.url) === parsed.data.url ? parsed.data : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function saveHubLink(link: HubLink | null): void {
  cached = link;
  try {
    if (link) localStorage.setItem(STORAGE_KEY, JSON.stringify(link));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode): the link lasts for this page only.
  }
}

export function routesToHub(kind: 'rpc' | 'table', name: string): boolean {
  if (!hubLink()) return false;
  return kind === 'rpc' ? isLanRpc(name) : LAN_TABLES.has(name);
}

// Errors are thrown as `{ message: CODE }` so src/api/client.ts maps them with
// the same safeError() used for Supabase responses.
class HubFailure extends Error {}

async function call(path: string, init: RequestInit = {}, timeout = 8_000): Promise<unknown> {
  const link = hubLink();
  if (!link) throw new HubFailure('HUB_NOT_PAIRED');
  let response: Response;
  try {
    response = await fetch(`${link.url}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${link.token}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new HubFailure('HUB_UNREACHABLE');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = z.object({ error: z.string().max(100) }).safeParse(body);
    throw new HubFailure(code.success ? code.data.error : 'HUB_UNREACHABLE');
  }
  return body;
}

export async function hubRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const body = await call(`/v1/rpc/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: JSON.stringify({ args }),
  });
  return z.object({ result: z.unknown() }).parse(body).result;
}

export async function hubRead(
  table: string,
  options: { filters?: Record<string, string>; after?: string | null; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.filters ?? {})) query.set(`eq.${key}`, value);
  if (options.after) query.set('after', options.after);
  if (options.limit) query.set('limit', String(options.limit));
  const body = await call(`/v1/table/${encodeURIComponent(table)}?${query.toString()}`);
  return z.object({ rows: z.array(z.record(z.string(), z.unknown())) }).parse(body).rows;
}

export const hubHealthSchema = z.object({
  hub_id: z.string(),
  generation: z.number(),
  authority: z.literal('VENUE_HUB'),
  acknowledged_seq: z.number(),
  sync_pending: z.boolean(),
});
export type HubHealth = z.infer<typeof hubHealthSchema>;

export async function hubHealth(url?: string): Promise<HubHealth> {
  const base = url ?? hubLink()?.url;
  if (!base) throw new HubFailure('HUB_NOT_PAIRED');
  let response: Response;
  try {
    response = await fetch(`${base}/v1/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    throw new HubFailure('HUB_UNREACHABLE');
  }
  if (!response.ok) throw new HubFailure('HUB_UNREACHABLE');
  return hubHealthSchema.parse(await response.json());
}

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), generation: z.number() }),
  z.object({ type: z.literal('sync'), seq: z.number().nullable() }),
  z.object({
    type: z.literal('signal'),
    id: z.string(),
    topic: z.string(),
    venue_id: z.string().nullable(),
    recipient_user_id: z.string().nullable(),
  }),
]);
export type HubEvent = z.infer<typeof eventSchema>;

/**
 * Streams hub invalidations with fetch (EventSource cannot send the device
 * credential in a header). Resolves when the stream ends or `signal` aborts.
 */
export async function hubEvents(
  onEvent: (event: HubEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const link = hubLink();
  if (!link) throw new HubFailure('HUB_NOT_PAIRED');
  const response = await fetch(`${link.url}/v1/events`, {
    headers: { authorization: `Bearer ${link.token}` },
    cache: 'no-store',
    signal,
  });
  if (!response.ok || !response.body) throw new HubFailure('HUB_UNREACHABLE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      if (!frame.startsWith('data: ') || frame.length > 4096) continue;
      try {
        const parsed = eventSchema.safeParse(JSON.parse(frame.slice(6)));
        if (parsed.success) onEvent(parsed.data);
      } catch {
        // Ignore a malformed frame; the periodic reconciliation still refreshes.
      }
    }
  }
}
