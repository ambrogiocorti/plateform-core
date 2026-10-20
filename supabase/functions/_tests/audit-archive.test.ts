import {
  ArchiveFailure,
  type ArchiveStore,
  chainSha256,
  type Checkpoint,
  comparePosition,
  type FinishArgs,
  importArchiveKey,
  loadKeyring,
  objectPath,
  openBatch,
  rotateArchive,
  sealBatch,
  sha256Hex,
  timestampMicros,
  verifyArchive,
  ZERO_CHAIN,
} from '../audit-archive-worker/archive.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    const actual = error instanceof ArchiveFailure ? error.code : (error as Error).message;
    assert(actual === code, `Expected ${code}, got ${actual}`);
    return;
  }
  throw new Error(`Expected ${code}, nothing thrown`);
}
function randomKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const START = { at: '2000-01-01T00:00:00+00:00', id: '00000000-0000-0000-0000-000000000000' };

function memoryStore(
  name: ArchiveStore['name'],
): ArchiveStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    name,
    objects,
    upload: async (path, bytes) => void objects.set(path, bytes.slice()),
    download: async (path) => objects.get(path)?.slice() ?? null,
  };
}

/** In-memory copy of the claim/read/finish/status/list RPCs of 20261011152001 + 20261011152612. */
function fakeDatabase(rowCount: number) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: uuid(i + 1),
    // Microsecond precision and a non-UTC offset, as PostgREST may render them.
    timestamp: `2026-10-${String(10 + Math.floor(i / 400)).padStart(2, '0')}T0${i % 10}:00:00.${String(
      100000 + i,
    )}+02:00`,
    action: 'TEST_EVENT',
    entity_type: 'test',
  })).sort((a, b) => comparePosition({ at: a.timestamp, id: a.id }, { at: b.timestamp, id: b.id }));
  const cursor = {
    at: START.at,
    id: START.id,
    batch: 0,
    chain: ZERO_CHAIN,
    lease: null as string | null,
  };
  const batches: Checkpoint[] = [];
  const after = (p: { at: string; id: string }) =>
    rows.filter((r) => comparePosition({ at: r.timestamp, id: r.id }, p) > 0);
  return {
    rows,
    cursor,
    batches,
    claim: async () => {
      if (cursor.lease) return { status: 'BUSY' };
      if (after(cursor).length === 0) return { status: 'IDLE', last_batch: cursor.batch };
      cursor.lease = crypto.randomUUID();
      return {
        status: 'CLAIMED',
        lease: cursor.lease,
        batch_no: cursor.batch + 1,
        last_at: cursor.at,
        last_id: cursor.id,
        previous_chain: cursor.chain,
      };
    },
    read: async (lease: string, limit: number) => {
      if (lease !== cursor.lease) throw new Error('AUDIT_ARCHIVE_LEASE_REQUIRED');
      return { rows: after(cursor).slice(0, limit), batch_no: cursor.batch + 1 };
    },
    finish: async (a: FinishArgs) => {
      if (a.p_lease !== cursor.lease) throw new Error('AUDIT_ARCHIVE_LEASE_EXPIRED');
      const seq = cursor.batch + 1;
      if (a.p_path !== objectPath(seq)) throw new Error('INVALID_ARCHIVE_RANGE');
      const range = after(cursor).filter(
        (r) =>
          comparePosition(
            { at: r.timestamp, id: r.id },
            { at: a.p_ending_at, id: a.p_ending_id },
          ) <= 0,
      );
      const last = range.at(-1)!;
      if (
        range.length !== a.p_row_count ||
        last.id !== a.p_ending_id ||
        last.timestamp !== a.p_ending_at
      )
        throw new Error('ARCHIVE_ROW_COUNT_CHANGED');
      const expected = await sha256Hex(
        `${cursor.chain}:${seq}:${a.p_payload_sha256}:${a.p_plaintext_sha256}:${a.p_row_count}:${a.p_ending_id}`,
      );
      if (expected !== a.p_chain_sha256) throw new Error('AUDIT_ARCHIVE_CHAIN_INVALID');
      batches.push({
        batch_no: seq,
        row_count: a.p_row_count,
        plaintext_sha256: a.p_plaintext_sha256,
        payload_sha256: a.p_payload_sha256,
        previous_chain_sha256: cursor.chain,
        chain_sha256: a.p_chain_sha256,
        ending_at: a.p_ending_at,
        ending_id: a.p_ending_id,
        object_path: a.p_path,
      });
      Object.assign(cursor, {
        at: a.p_ending_at,
        id: a.p_ending_id,
        batch: seq,
        chain: a.p_chain_sha256,
        lease: null,
      });
      return {
        status: 'SEALED',
        batch_no: seq,
        chain_sha256: a.p_chain_sha256,
        rows: a.p_row_count,
      };
    },
    release: async (lease: string) => {
      if (cursor.lease === lease) cursor.lease = null;
    },
    status: async () => ({ last_batch: cursor.batch, chain_sha256: cursor.chain }),
    checkpoints: async (afterBatch: number, limit: number) =>
      batches
        .filter((b) => b.batch_no > afterBatch)
        .slice(0, limit)
        .map((b) => ({ ...b })),
  };
}

async function archived(rowCount: number, maxBatches = 20) {
  const db = fakeDatabase(rowCount),
    primary = memoryStore('PRIMARY'),
    replica = memoryStore('REPLICA'),
    key = await importArchiveKey('k2026', randomKey());
  const result = await rotateArchive({
    ...db,
    stores: [primary, replica],
    key,
    maxBatches,
    deadline: Date.now() + 60_000,
    now: () => Date.now(),
  });
  return { db, primary, replica, key, result, keys: new Map([[key.id, key.key]]) };
}

Deno.test('object path and chain digest follow finish_audit_archive_batch exactly', async () => {
  assert(objectPath(1) === 'v1/batch-000000001.bin', 'path format');
  assert(objectPath(123456789) === 'v1/batch-123456789.bin', 'path width');
  await rejects(async () => objectPath(0), 'INVALID_ARCHIVE_BATCH');
  const a = 'a'.repeat(64),
    b = 'b'.repeat(64);
  const chain = await chainSha256(ZERO_CHAIN, 7, a, b, 42, 'ABCDEF00-0000-4000-8000-000000000001');
  const expected = await sha256Hex(
    `${ZERO_CHAIN}:7:${a}:${b}:42:abcdef00-0000-4000-8000-000000000001`,
  );
  assert(chain === expected, 'chain digest differs from the SQL formula');
});

Deno.test('timestamps compare exactly at microsecond precision across offsets', () => {
  assert(
    timestampMicros('2026-10-20T10:00:00.123456+00:00') ===
      timestampMicros('2026-10-20 12:00:00.123456+02'),
    'offset normalization',
  );
  assert(
    timestampMicros('2026-10-20T10:00:00.123457Z') -
      timestampMicros('2026-10-20T10:00:00.123456Z') ===
      1n,
    'microseconds lost',
  );
  assert(
    comparePosition(
      { at: '2026-10-20T10:00:00Z', id: uuid(2) },
      { at: '2026-10-20T10:00:00Z', id: uuid(1) },
    ) > 0,
    'id tie-break',
  );
});

Deno.test('keyring requires 32-byte keys and keeps rotated keys for verification', async () => {
  await rejects(
    () =>
      loadKeyring(
        (n) => ({ AUDIT_ARCHIVE_KEY_ID: 'k1', AUDIT_ARCHIVE_ENCRYPTION_KEY: btoa('short') })[n],
      ),
    'ARCHIVE_KEY_INVALID',
  );
  await rejects(
    () => loadKeyring((n) => ({ AUDIT_ARCHIVE_KEY_ID: 'k1' })[n]),
    'ARCHIVE_KEY_INVALID',
  );
  const ring = await loadKeyring(
    (n) =>
      ({
        AUDIT_ARCHIVE_KEY_ID: 'k2',
        AUDIT_ARCHIVE_ENCRYPTION_KEY: randomKey(),
        AUDIT_ARCHIVE_PREVIOUS_KEYS: `k1=${randomKey()}`,
      })[n],
  );
  assert(ring.current?.id === 'k2' && ring.keys.has('k1') && ring.keys.has('k2'), 'keyring');
  const empty = await loadKeyring(() => undefined);
  assert(empty.current === null && empty.keys.size === 0, 'unconfigured keyring');
});

Deno.test('rotation seals 500-row batches to primary and replica, then goes idle', async () => {
  const { db, primary, replica, result } = await archived(1201);
  assert(result.batches_sealed === 3 && result.rows_archived === 1201, 'batch totals');
  assert(result.stopped === 'IDLE' && result.last_batch === 3, `stopped ${result.stopped}`);
  assert(db.batches.map((b) => b.row_count).join() === '500,500,201', 'batch sizes');
  assert(db.cursor.chain === result.chain_sha256 && db.cursor.lease === null, 'cursor');
  for (const b of db.batches) {
    const p = primary.objects.get(b.object_path)!,
      r = replica.objects.get(b.object_path)!;
    assert(
      (await sha256Hex(p)) === b.payload_sha256 && (await sha256Hex(r)) === b.payload_sha256,
      'stored',
    );
    assert(!new TextDecoder().decode(p).includes('TEST_EVENT'), 'archive is not encrypted');
  }
});

Deno.test('rotation honours max_batches and releases the lease when storage fails', async () => {
  const limited = await archived(1201, 2);
  assert(limited.result.stopped === 'MAX_BATCHES' && limited.result.batches_sealed === 2, 'max');
  const db = fakeDatabase(10),
    primary = memoryStore('PRIMARY'),
    broken: ArchiveStore = {
      name: 'REPLICA',
      upload: async () => {
        throw new Error('ARCHIVE_UPLOAD_FAILED');
      },
      download: async () => null,
    };
  await rejects(
    () =>
      rotateArchive({
        ...db,
        stores: [primary, broken],
        key: limited.key,
        maxBatches: 5,
        deadline: Date.now() + 60_000,
        now: () => Date.now(),
      }),
    'ARCHIVE_UPLOAD_FAILED',
  );
  assert(
    db.cursor.batch === 0 && db.cursor.lease === null && db.batches.length === 0,
    'not sealed',
  );
  await rejects(
    () =>
      rotateArchive({
        ...db,
        stores: [primary],
        key: limited.key,
        maxBatches: 5,
        deadline: Date.now() + 60_000,
        now: () => Date.now(),
      }),
    'ARCHIVE_REPLICA_REQUIRED',
  );
  db.cursor.lease = crypto.randomUUID();
  const busy = await rotateArchive({
    ...db,
    stores: [primary, memoryStore('REPLICA')],
    key: limited.key,
    maxBatches: 5,
    deadline: Date.now() + 60_000,
    now: () => Date.now(),
  });
  assert(busy.stopped === 'BUSY' && busy.batches_sealed === 0, 'busy lease respected');
});

Deno.test('daily verification recovers the latest 25 batches from both stores', async () => {
  const { db, primary, replica, keys } = await archived(30 * 20 + 7, 40);
  // Fewer than 25 batches: every batch is checked. Then 30 batches of 20 rows: only the last 25.
  assert(db.batches.length === 2, 'setup');
  const small = fakeDatabase(30 * 20);
  const p = memoryStore('PRIMARY'),
    r = memoryStore('REPLICA'),
    key = await importArchiveKey('k1', randomKey());
  const smallRead = small.read;
  await rotateArchive({
    ...small,
    read: (lease, _limit) => smallRead(lease, 20),
    stores: [p, r],
    key,
    maxBatches: 40,
    deadline: Date.now() + 60_000,
    now: () => Date.now(),
  });
  assert(small.batches.length === 30, `batches ${small.batches.length}`);
  const smallKeys = new Map([[key.id, key.key]]);
  const pass = await verifyArchive({ ...small, stores: [p, r], keys: smallKeys });
  assert(pass.pass && pass.batches === 25 && pass.rows === 500, JSON.stringify(pass));
  assert(pass.chain === small.cursor.chain, 'final chain must equal the cursor head');
  const few = await verifyArchive({ ...db, stores: [primary, replica], keys });
  assert(few.pass && few.batches === 2 && few.rows === 607, JSON.stringify(few));
});

Deno.test(
  'verification fails closed on tampering, missing objects, keys and chain breaks',
  async () => {
    const fresh = async () => await archived(1201);
    const failure = async (
      mutate: (x: Awaited<ReturnType<typeof fresh>>) => void | Promise<void>,
      code: string,
    ) => {
      const x = await fresh();
      await mutate(x);
      const result = await verifyArchive({ ...x.db, stores: [x.primary, x.replica], keys: x.keys });
      assert(
        !result.pass && result.failure === code && result.chain === null,
        `${code}: ${JSON.stringify(result)}`,
      );
    };
    await failure((x) => {
      const bytes = x.replica.objects.get(objectPath(2))!;
      bytes[bytes.length - 1]! ^= 1;
    }, 'ARCHIVE_PAYLOAD_HASH_MISMATCH');
    await failure(
      (x) => void x.replica.objects.delete(objectPath(3)),
      'ARCHIVE_REPLICA_OBJECT_MISSING',
    );
    await failure(
      (x) => void x.primary.objects.delete(objectPath(1)),
      'ARCHIVE_PRIMARY_OBJECT_MISSING',
    );
    await failure((x) => x.keys.clear(), 'ARCHIVE_KEY_NOT_CONFIGURED');
    await failure(async (x) => {
      x.keys.clear();
      x.keys.set('other', (await importArchiveKey('other', randomKey())).key);
    }, 'ARCHIVE_KEY_UNAVAILABLE');
    await failure(async (x) => {
      x.keys.set('k2026', (await importArchiveKey('k2026', randomKey())).key);
    }, 'ARCHIVE_DECRYPTION_FAILED');
    await failure((x) => {
      x.db.batches[1]!.chain_sha256 = 'f'.repeat(64);
    }, 'ARCHIVE_CHAIN_INVALID');
    await failure((x) => {
      x.db.batches[2]!.previous_chain_sha256 = 'e'.repeat(64);
    }, 'ARCHIVE_CHAIN_LINK_BROKEN');
    await failure((x) => {
      x.db.cursor.chain = 'd'.repeat(64);
    }, 'ARCHIVE_CHAIN_HEAD_MISMATCH');
    await failure((x) => {
      x.db.batches.splice(1, 1);
    }, 'ARCHIVE_CHECKPOINTS_INCOMPLETE');
    await failure(async (x) => {
      // Swapping two valid objects is caught: the path is authenticated with the ciphertext.
      const one = x.primary.objects.get(objectPath(1))!;
      x.primary.objects.set(objectPath(2), one);
      x.db.batches[1]!.payload_sha256 = await sha256Hex(one);
    }, 'ARCHIVE_DECRYPTION_FAILED');
    const empty = fakeDatabase(0);
    const none = await verifyArchive({
      ...empty,
      stores: [memoryStore('PRIMARY')],
      keys: new Map(),
    });
    assert(!none.pass && none.failure === 'NO_ARCHIVE_BATCHES', 'empty archive is not a pass');
  },
);

Deno.test('sealing rejects unordered rows and openBatch checks the checkpoint range', async () => {
  const key = await importArchiveKey('k1', randomKey());
  const rows = [
    { id: uuid(2), timestamp: '2026-10-20T10:00:00.000002Z' },
    { id: uuid(1), timestamp: '2026-10-20T10:00:00.000001Z' },
  ];
  await rejects(
    () => sealBatch({ batchNo: 1, previousChain: ZERO_CHAIN, after: START, rows, key }),
    'ARCHIVE_ROW_ORDER_INVALID',
  );
  const sealed = await sealBatch({
    batchNo: 1,
    previousChain: ZERO_CHAIN,
    after: START,
    rows: rows.reverse(),
    key,
  });
  assert(
    sealed.endingAt === '2026-10-20T10:00:00.000002Z' && sealed.rowCount === 2,
    'ending kept verbatim',
  );
  const checkpoint: Checkpoint = {
    batch_no: 1,
    row_count: 2,
    plaintext_sha256: sealed.plaintextSha256,
    payload_sha256: sealed.payloadSha256,
    previous_chain_sha256: ZERO_CHAIN,
    chain_sha256: sealed.chainSha256,
    ending_at: '2026-10-20 12:00:00.000002+02',
    ending_id: sealed.endingId,
    object_path: sealed.path,
  };
  const keys = new Map([[key.id, key.key]]);
  assert((await openBatch(sealed.bytes, checkpoint, keys, START)).rows === 2, 'open');
  await rejects(
    () => openBatch(sealed.bytes, { ...checkpoint, ending_id: uuid(1) }, keys, START),
    'ARCHIVE_CONTENT_MISMATCH',
  );
  await rejects(
    () => openBatch(sealed.bytes, checkpoint, keys, { at: START.at, id: uuid(9) }),
    'ARCHIVE_RANGE_GAP',
  );
});
