import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { BridgeStore } from '../../tools/print-bridge/store';
import { eposSuccess } from '../../tools/print-bridge/protocol';
import { startBridge } from '../../tools/print-bridge/service';
import {
  documentHash,
  signPrintAuthorization,
  verifyPrintAuthorization,
  type PrintAuthorization,
} from '../../shared/print-authorization';
const at = Date.parse('2026-10-03T12:00:00Z'),
  expected = {
    issuer: 'https://database.test',
    bridge_origin: 'https://bridge.test',
    staff_origin: 'https://staff.test',
  };
const job = '10000000-0000-4000-8000-000000000001',
  device = '10000000-0000-4000-8000-000000000002',
  lease = '10000000-0000-4000-8000-000000000003';
const claims: PrintAuthorization = {
  audience: 'plateform-print-bridge',
  ...expected,
  job_id: job,
  device_id: device,
  lease_id: lease,
  document_sha256: 'a'.repeat(64),
  issued_at: new Date(at).toISOString(),
  expires_at: new Date(at + 120000).toISOString(),
};
describe('signed print dispatch', () => {
  let publicKey: JsonWebKey, privateKey: JsonWebKey;
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
    privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
  });
  it('binds a short authorization to the job, printer, issuer, staff and bridge origins', async () => {
    const token = await signPrintAuthorization(claims, privateKey);
    expect(await verifyPrintAuthorization(token, [publicKey], expected, at + 1000)).toEqual(claims);
    await expect(
      verifyPrintAuthorization(
        token,
        [publicKey],
        { ...expected, staff_origin: 'https://attacker.test' },
        at + 1000,
      ),
    ).rejects.toThrow('INVALID_PRINT_AUTHORIZATION');
    await expect(
      verifyPrintAuthorization(token, [publicKey], expected, at + 120000),
    ).rejects.toThrow('PRINT_AUTHORIZATION_EXPIRED');
  });
  it('rejects changed print data and a private key configured as a trust anchor', async () => {
    const token = await signPrintAuthorization(claims, privateKey);
    await expect(
      verifyPrintAuthorization(
        { ...token, payload: token.payload.replace(device, lease) },
        [publicKey],
        expected,
        at + 1000,
      ),
    ).rejects.toThrow();
    await expect(
      verifyPrintAuthorization(token, [privateKey], expected, at + 1000),
    ).rejects.toThrow();
  });
  it('does not interpret malformed XML, false responses or foreign namespaces as successful printing', () => {
    const response =
      '<response xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print" success="true" code=""/>';
    expect(eposSuccess(response)).toBe(true);
    for (const xml of [
      response + '<broken',
      response.replace('true', 'false'),
      response.replace('code=""', 'code="EPTR_PAPER_END"'),
      response.replace('http://www.epson-pos.com/schemas/2011/03/epos-print', 'urn:attacker'),
      '<!DOCTYPE response [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + response,
      '<root>' + response + response + '</root>',
    ])
      expect(eposSuccess(xml)).toBe(false);
  });
  it('keeps deduplication and uncertain physical outcomes across a process restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plateform-print-'));
    try {
      let store = new BridgeStore(join(directory, 'jobs.sqlite'));
      expect(store.claim(job, device, 'a')).toBe('NEW');
      expect(store.claim(job, device, 'a')).toBe('SENT');
      store.close();
      store = new BridgeStore(join(directory, 'jobs.sqlite'));
      expect(store.claim(job, device, 'a')).toBe('UNKNOWN');
      expect(() => store.claim(job, device, 'changed')).toThrow('IDEMPOTENCY_MISMATCH');
      const next = crypto.randomUUID();
      expect(store.claim(next, device, 'b')).toBe('NEW');
      store.finish(next, true);
      store.close();
      store = new BridgeStore(join(directory, 'jobs.sqlite'));
      expect(store.claim(next, device, 'b')).toBe('SUCCESS');
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
describe('local HTTPS print bridge', () => {
  let directory: string,
    bridge: ReturnType<typeof startBridge>,
    printer: ReturnType<typeof createServer>,
    ca: Buffer,
    publicKey: JsonWebKey,
    privateKey: JsonWebKey,
    port: number,
    sent = 0;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'plateform-bridge-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(directory, 'test.key'),
        '-out',
        join(directory, 'test.crt'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
    ca = readFileSync(join(directory, 'test.crt'));
    printer = createServer(
      { key: readFileSync(join(directory, 'test.key')), cert: ca },
      async (req, res) => {
        for await (const _chunk of req) {
          void _chunk;
        }
        sent++;
        res.end(
          '<response xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print" success="true" code=""/>',
        );
      },
    );
    printer.listen(0, '127.0.0.1');
    await once(printer, 'listening');
    const printerPort = (printer.address() as { port: number }).port;
    const leasePort = createTcpServer();
    leasePort.listen(0, '127.0.0.1');
    await once(leasePort, 'listening');
    port = (leasePort.address() as { port: number }).port;
    await new Promise<void>((resolve) => leasePort.close(() => resolve()));
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
    privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        host: '127.0.0.1',
        port,
        origin: `https://localhost:${port}`,
        issuer: expected.issuer,
        allowed_origins: [expected.staff_origin],
        public_keys: [publicKey],
        certificate_file: 'test.crt',
        private_key_file: 'test.key',
        database_file: 'jobs.sqlite',
        printers: [
          {
            device_id: device,
            endpoint: `https://localhost:${printerPort}/cgi-bin/epos/service.cgi`,
            ca_file: 'test.crt',
          },
        ],
      }),
    );
    bridge = startBridge(join(directory, 'config.json'));
    await once(bridge.server, 'listening');
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => bridge?.server.close(() => resolve()));
    bridge?.store.close();
    await new Promise<void>((resolve) => printer?.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  async function post(
    body: unknown,
    origin = expected.staff_origin,
  ): Promise<{ status: number; body: { success?: boolean; code: string } }> {
    return new Promise((resolve, reject) => {
      const req = request(
        `https://localhost:${port}/v1/print`,
        { method: 'POST', ca, headers: { Origin: origin, 'Content-Type': 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }
  async function body(id = job) {
    const document = '<signed-fixture/>',
      now = Date.now();
    return {
      document,
      authorization: await signPrintAuthorization(
        {
          ...claims,
          job_id: id,
          bridge_origin: `https://localhost:${port}`,
          document_sha256: await documentHash(document),
          issued_at: new Date(now).toISOString(),
          expires_at: new Date(now + 120000).toISOString(),
        },
        privateKey,
      ),
    };
  }
  it('sends one physical request and replays only its persisted positive result', async () => {
    const signed = await body();
    expect((await post(signed)).body.success).toBe(true);
    expect((await post(signed)).body.success).toBe(true);
    expect(sent).toBe(1);
  });
  it('rejects a foreign origin and a changed document before contacting a printer', async () => {
    const signed = await body(crypto.randomUUID());
    expect((await post(signed, 'https://attacker.test')).status).toBe(403);
    expect((await post({ ...signed, document: 'tampered' })).body.code).toBe(
      'INVALID_PRINT_AUTHORIZATION',
    );
    expect(sent).toBe(1);
  });
});
