import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { HubError, type VenueHub } from './hub.ts';

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

type Subscriber = { res: ServerResponse; userId: string };

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
        const sub = { res, userId: device.user_id };
        subscribers.add(sub);
        req.on('close', () => subscribers.delete(sub));
        return;
      }

      const table = /^\/v1\/table\/([a-z_]{1,64})$/.exec(url.pathname)?.[1];
      if (req.method === 'GET' && table) {
        const id = url.searchParams.get('id') ?? undefined;
        send(res, 200, { rows: await hub.read(device, table, id) }, allowedOrigin);
        return;
      }

      const rpc = /^\/v1\/rpc\/([a-z_]{1,64})$/.exec(url.pathname)?.[1];
      if (req.method === 'POST' && rpc) {
        // Requiring JSON forces a CORS preflight for cross-site browser requests.
        if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
          throw new HubError('JSON_REQUIRED', 415);
        const body = (await readBody(req)) as { args?: unknown };
        const outcome = await hub.rpc(device, rpc, Array.isArray(body?.args) ? body.args : []);
        send(res, 200, { result: outcome.result }, allowedOrigin);
        // Invalidation only: clients re-read through authorised RPCs, so the
        // event stream never carries data a subscriber could not read itself.
        if (outcome.write) broadcast({ type: 'changed', rpc, seq: outcome.seq });
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
