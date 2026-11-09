import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { HubError, type HubSignal, type VenueHub } from './hub.ts';

// LAN HTTP surface of the venue hub. In production it is served over HTTPS with
// a certificate trusted by the paired devices (see ADR-0001); the transport is
// injected so tests can run on loopback HTTP without weakening the checks below.

export type HubServerOptions = {
  // Exact Host header values accepted (DNS rebinding protection).
  allowedHosts: string[];
  // Exact browser origins allowed to call the hub (CSRF/cross-site protection).
  allowedOrigins: string[];
  maxBodyBytes?: number;
};

type Subscriber = { res: ServerResponse; userId: string; venues: Set<string> };

export function createHubServer(hub: VenueHub, options: HubServerOptions): Server {
  const subscribers = new Set<Subscriber>();
  const maxBody = options.maxBodyBytes ?? 64 * 1024;

  const send = (res: ServerResponse, status: number, body: unknown, origin?: string) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (origin) {
      headers['access-control-allow-origin'] = origin;
      headers['vary'] = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  const broadcast = (event: unknown) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const s of subscribers) s.res.write(line);
  };

  // Same delivery rule as the cloud Realtime filters used by src/realtime/live.ts:
  // a personal signal reaches only its recipient, a venue signal only staff of
  // that venue. Signals carry identifiers and topics, never business data.
  const deliver = (signals: HubSignal[]) => {
    for (const signal of signals) {
      const line = `data: ${JSON.stringify({ type: 'signal', ...signal })}\n\n`;
      for (const s of subscribers) {
        const allowed = signal.recipient_user_id
          ? signal.recipient_user_id === s.userId
          : signal.venue_id !== null && s.venues.has(signal.venue_id);
        if (allowed) s.res.write(line);
      }
    }
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBody) {
          reject(new HubError('PAYLOAD_TOO_LARGE', 413));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HubError('INVALID_JSON', 400));
        }
      });
      req.on('error', reject);
    });

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowedOrigin = origin && options.allowedOrigins.includes(origin) ? origin : undefined;
    try {
      if (!req.headers.host || !options.allowedHosts.includes(req.headers.host))
        throw new HubError('HOST_NOT_ALLOWED', 421);
      if (origin && !allowedOrigin) throw new HubError('ORIGIN_NOT_ALLOWED', 403);
      const url = new URL(req.url ?? '/', 'http://hub.invalid');

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...(allowedOrigin
            ? {
                'access-control-allow-origin': allowedOrigin,
                'access-control-allow-methods': 'GET, POST',
                'access-control-allow-headers': 'authorization, content-type',
                'access-control-max-age': '600',
                vary: 'Origin',
              }
            : {}),
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/health') {
        const pending = (await hub.pendingChanges(1)).length > 0;
        send(
          res,
          200,
          {
            hub_id: hub.hubId,
            generation: hub.generation,
            authority: 'VENUE_HUB',
            acknowledged_seq: await hub.acknowledgedSeq(),
            sync_pending: pending,
          },
          allowedOrigin,
        );
        return;
      }

      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const device = hub.authenticate(token);

      if (req.method === 'GET' && url.pathname === '/v1/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          ...(allowedOrigin
            ? { 'access-control-allow-origin': allowedOrigin, vary: 'Origin' }
            : {}),
        });
        res.write(`data: ${JSON.stringify({ type: 'hello', generation: hub.generation })}\n\n`);
        const sub = { res, userId: device.user_id, venues: await hub.venuesOf(device.user_id) };
        subscribers.add(sub);
        req.on('close', () => subscribers.delete(sub));
        return;
      }

      const table = /^\/v1\/table\/([a-z_]{1,64})$/.exec(url.pathname)?.[1];
      if (req.method === 'GET' && table) {
        // Equality filters use `eq.<column>=<value>`; pagination uses `after` and `limit`.
        const filters: Record<string, string> = {};
        for (const [key, value] of url.searchParams)
          if (key.startsWith('eq.')) filters[key.slice(3)] = value;
        const after = url.searchParams.get('after') ?? undefined;
        const limit = url.searchParams.has('limit')
          ? Number(url.searchParams.get('limit'))
          : undefined;
        const rows = await hub.read(device, table, {
          filters,
          ...(after !== undefined ? { after } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        send(res, 200, { rows }, allowedOrigin);
        return;
      }

      const rpc = /^\/v1\/rpc\/([a-z_]{1,64})$/.exec(url.pathname)?.[1];
      if (req.method === 'POST' && rpc) {
        // Requiring JSON forces a CORS preflight for cross-site browser requests.
        if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
          throw new HubError('JSON_REQUIRED', 415);
        const body = (await readBody(req)) as { args?: unknown };
        const args = body?.args;
        if (args === null || typeof args !== 'object' || Array.isArray(args))
          throw new HubError('RPC_ARGUMENTS_REQUIRED', 400);
        const outcome = await hub.rpc(device, rpc, args as Record<string, unknown>);
        send(res, 200, { result: outcome.result }, allowedOrigin);
        // Invalidations only: clients re-read through authorised RPCs, so the
        // event stream never carries data a subscriber could not read itself.
        deliver(outcome.signals);
        if (outcome.write) broadcast({ type: 'sync', seq: outcome.seq });
        return;
      }
      throw new HubError('NOT_FOUND', 404);
    } catch (error) {
      const e = error instanceof HubError ? error : new HubError('HUB_INTERNAL_ERROR', 500);
      send(res, e.status, { error: e.code }, allowedOrigin);
    }
  });
  server.on('close', () => {
    for (const s of subscribers) s.res.end();
    subscribers.clear();
  });
  return server;
}
