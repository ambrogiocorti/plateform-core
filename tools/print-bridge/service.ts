import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer, request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  publicPrintKey,
  verifyPrintAuthorization,
  documentHash,
} from '../../shared/print-authorization.ts';
import { BridgeStore } from './store.ts';
import { eposSuccess } from './protocol.ts';
const origin = z.url().refine((value) => {
  const u = new URL(value);
  return u.protocol === 'https:' && u.origin === value && !u.username && !u.password;
}, 'HTTPS_ORIGIN_REQUIRED');
const configSchema = z
  .object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1024).max(65535).default(7443),
    origin,
    issuer: origin,
    allowed_origins: z.array(origin).min(1).max(10),
    public_keys: z
      .array(
        z.custom<JsonWebKey>(
          (value) => typeof value === 'object' && value !== null && publicPrintKey(value),
        ),
      )
      .min(1)
      .max(3),
    certificate_file: z.string().min(1),
    private_key_file: z.string().min(1),
    database_file: z.string().min(1),
    printers: z
      .array(
        z
          .object({
            device_id: z.uuid(),
            endpoint: z.url().refine((value) => {
              const u = new URL(value);
              return (
                u.protocol === 'https:' &&
                !u.username &&
                !u.password &&
                !u.hash &&
                u.pathname === '/cgi-bin/epos/service.cgi'
              );
            }),
            ca_file: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
const bodySchema = z
  .object({
    document: z.string().min(1).max(65536),
    authorization: z
      .object({ payload: z.string().max(4096), signature: z.string().length(86) })
      .strict(),
  })
  .strict();
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw new Error('INVALID_PAYLOAD');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 131072) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
function transmit(endpoint: string, document: string, ca?: Buffer): Promise<boolean> {
  return new Promise((resolveResult) => {
    let settled = false;
    const timer = setTimeout(() => {
      outgoing?.destroy();
      finish(false);
    }, 45000);
    const finish = (success: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveResult(success);
      }
    };
    const outgoing = httpsRequest(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(document),
          SOAPAction: '""',
        },
        ...(ca ? { ca } : {}),
        rejectUnauthorized: true,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 32768) {
            response.destroy();
            finish(false);
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            finish(false);
            return;
          }
          try {
            finish(
              eposSuccess(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
            );
          } catch {
            finish(false);
          }
        });
        response.on('error', () => finish(false));
        response.on('aborted', () => finish(false));
      },
    );
    outgoing.setTimeout(45000, () => {
      outgoing.destroy();
      finish(false);
    });
    outgoing.on('error', () => finish(false));
    outgoing.end(document);
  });
}
export function startBridge(file: string) {
  const directory = dirname(resolve(file)),
    path = (value: string) => resolve(directory, value);
  const config = configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (new Set(config.printers.map((printer) => printer.device_id)).size !== config.printers.length)
    throw new Error('DUPLICATE_PRINTER');
  const dbPath = path(config.database_file);
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const store = new BridgeStore(dbPath);
  chmodSync(dbPath, 0o600);
  const printers = new Map(
    config.printers.map((printer) => [
      printer.device_id,
      { ...printer, ca: printer.ca_file ? readFileSync(path(printer.ca_file)) : undefined },
    ]),
  );
  const chains = new Map<string, Promise<void>>();
  const rates = new Map<string, { at: number; count: number }>();
  let inFlight = 0;
  const respond = (response: ServerResponse, code: number, body: unknown) => {
    response.statusCode = code;
    response.end(JSON.stringify(body));
  };
  const server = createServer(
    {
      cert: readFileSync(path(config.certificate_file)),
      key: readFileSync(path(config.private_key_file)),
      minVersion: 'TLSv1.2',
    },
    async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Vary', 'Origin');
      const requestOrigin = request.headers.origin;
      if (
        !requestOrigin ||
        !config.allowed_origins.includes(requestOrigin) ||
        request.headers.host !== new URL(config.origin).host
      ) {
        respond(response, 403, { code: 'ORIGIN_FORBIDDEN' });
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', requestOrigin);
      response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'content-type');
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.url === '/health' && request.method === 'GET') {
        respond(response, 200, { status: 'READY', protocol: 1 });
        return;
      }
      if (request.url !== '/v1/print' || request.method !== 'POST') {
        respond(response, 404, { code: 'NOT_FOUND' });
        return;
      }
      const prior = rates.get(requestOrigin),
        rate = prior && Date.now() - prior.at < 600000 ? prior : { at: Date.now(), count: 0 };
      rates.set(requestOrigin, rate);
      if (++rate.count > 1000 || inFlight >= 20) {
        respond(response, 429, { code: 'RATE_LIMITED' });
        return;
      }
      inFlight++;
      try {
        const body = bodySchema.parse(await readBody(request));
        if (Buffer.byteLength(body.document) > 65536) throw new Error('PAYLOAD_TOO_LARGE');
        const claims = await verifyPrintAuthorization(body.authorization, config.public_keys, {
          issuer: config.issuer,
          bridge_origin: config.origin,
          staff_origin: requestOrigin,
        });
        if ((await documentHash(body.document)) !== claims.document_sha256)
          throw new Error('INVALID_PRINT_AUTHORIZATION');
        const printer = printers.get(claims.device_id);
        if (!printer) throw new Error('PRINTER_NOT_CONFIGURED');
        const state = store.claim(claims.job_id, claims.device_id, claims.document_sha256);
        if (state !== 'NEW') {
          respond(response, state === 'SUCCESS' ? 200 : 409, {
            job_id: claims.job_id,
            success: state === 'SUCCESS',
            code: state === 'SUCCESS' ? 'ALREADY_PRINTED' : 'PRINT_OUTCOME_UNKNOWN',
          });
          return;
        }
        const priorTask = chains.get(claims.device_id) ?? Promise.resolve();
        let success = false;
        const task = priorTask
          .catch(() => {})
          .then(async () => {
            // A queued request must still be authorized at the actual dispatch time.
            if (Date.now() < Date.parse(claims.expires_at))
              success = await transmit(printer.endpoint, body.document, printer.ca);
            store.finish(claims.job_id, success);
          });
        chains.set(claims.device_id, task);
        await task;
        if (chains.get(claims.device_id) === task) chains.delete(claims.device_id);
        respond(response, success ? 200 : 409, {
          job_id: claims.job_id,
          success,
          code: success ? 'PRINT_SUCCESS' : 'PRINT_OUTCOME_UNKNOWN',
        });
        console.log(
          JSON.stringify({
            event: success ? 'PRINT_SUCCESS' : 'PRINT_OUTCOME_UNKNOWN',
            job_id: claims.job_id,
            device_id: claims.device_id,
          }),
        );
      } catch (error) {
        const code =
          error instanceof Error &&
          [
            'INVALID_PRINT_AUTHORIZATION',
            'PRINT_AUTHORIZATION_EXPIRED',
            'IDEMPOTENCY_MISMATCH',
            'PRINTER_NOT_CONFIGURED',
            'PAYLOAD_TOO_LARGE',
          ].includes(error.message)
            ? error.message
            : 'INVALID_PAYLOAD';
        respond(response, code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { code });
      } finally {
        inFlight--;
      }
    },
  );
  server.maxConnections = 64;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  server.listen(config.port, config.host, () =>
    console.log(JSON.stringify({ event: 'BRIDGE_READY', port: config.port })),
  );
  return { server, store };
}
