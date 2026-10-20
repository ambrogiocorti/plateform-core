// Pure audit-archive logic shared by `audit-archive-worker` and `audit-archive-verify`.
// No network and no Supabase client here, so every rule is unit tested offline.
//
// Contract (migrations 20261011152001, 20261011153016, 20261011153304, 20261019090000):
// - one batch = up to 500 `public.audit_log` rows after the cursor, older than 5 minutes,
//   exactly as `read_audit_archive_batch` returns them (sensitive columns already removed);
// - object path `v1/batch-<9-digit batch_no>.bin`;
// - payload_sha256 = SHA-256 of the stored (encrypted) object bytes;
// - plaintext_sha256 = SHA-256 of the decrypted archive document bytes;
// - chain_sha256 = SHA-256(previous_chain ':' batch_no ':' payload ':' plaintext ':' row_count
//   ':' ending_id), recomputed by `finish_audit_archive_batch` before it seals the checkpoint.
import { z } from 'npm:zod@4.6.5';

export const ZERO_CHAIN = '0'.repeat(64);
export const MAX_ROWS_PER_BATCH = 500;
/** `get_audit_certification_gates` requires checked_batches = least(last_batch, 25). */
export const VERIFY_WINDOW = 25;
export const ARCHIVE_FORMAT = 'plateform.audit_archive';
export const ARCHIVE_VERSION = 1;

const MAGIC = new Uint8Array([0x50, 0x4c, 0x41, 0x41, 0x01]); // "PLAA" + format version 1
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const encoder = new TextEncoder();

/** A verification failure with a code accepted by `record_audit_archive_verification`. */
export class ArchiveFailure extends Error {
  constructor(public readonly code: string) {
    super(code);
    if (!/^[A-Z0-9_]{1,80}$/.test(code)) throw new Error('INVALID_FAILURE_CODE');
  }
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

export function objectPath(batchNo: number): string {
  if (!Number.isSafeInteger(batchNo) || batchNo < 1 || batchNo > 999_999_999)
    throw new Error('INVALID_ARCHIVE_BATCH');
  return `v1/batch-${String(batchNo).padStart(9, '0')}.bin`;
}

/** Mirrors the digest computed in `public.finish_audit_archive_batch`. */
export function chainSha256(
  previousChain: string,
  batchNo: number,
  payloadSha256: string,
  plaintextSha256: string,
  rowCount: number,
  endingId: string,
): Promise<string> {
  if (![previousChain, payloadSha256, plaintextSha256].every((value) => HEX64.test(value)))
    throw new Error('INVALID_ARCHIVE_HASH');
  if (!UUID.test(endingId)) throw new Error('INVALID_ARCHIVE_ROW');
  return sha256Hex(
    `${previousChain}:${batchNo}:${payloadSha256}:${plaintextSha256}:${rowCount}:${endingId.toLowerCase()}`,
  );
}

/** Exact timestamptz value in microseconds since the epoch (JavaScript Date drops microseconds). */
export function timestampMicros(value: string): bigint {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
      value,
    );
  if (!match) throw new Error('INVALID_ARCHIVE_TIMESTAMP');
  const [, y, mo, d, h, mi, s, fraction = '', zone] = match;
  const seconds = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(seconds)) throw new Error('INVALID_ARCHIVE_TIMESTAMP');
  let offset = 0;
  if (zone !== 'Z') {
    const digits = zone!.slice(1).replace(':', '');
    offset =
      (zone![0] === '-' ? -1 : 1) *
      (Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || '0') * 60);
  }
  return (
    (BigInt(seconds) / 1000n - BigInt(offset)) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0')
  );
}

export type Position = { at: string; id: string };

/** Same ordering as the SQL row comparison (timestamp, id); uuid order is lowercase hex order. */
export function comparePosition(left: Position, right: Position): number {
  const a = timestampMicros(left.at),
    b = timestampMicros(right.at);
  if (a !== b) return a < b ? -1 : 1;
  const x = left.id.toLowerCase(),
    y = right.id.toLowerCase();
  return x === y ? 0 : x < y ? -1 : 1;
}

const rowSchema = z
  .object({ id: z.string().regex(UUID), timestamp: z.string().min(10).max(64) })
  .passthrough();
export type AuditRow = z.infer<typeof rowSchema>;

function validateRows(rows: unknown[], after: Position): AuditRow[] {
  if (rows.length < 1 || rows.length > MAX_ROWS_PER_BATCH)
    throw new ArchiveFailure('ARCHIVE_ROW_COUNT_INVALID');
  let previous = after;
  return rows.map((raw) => {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) throw new ArchiveFailure('ARCHIVE_ROW_INVALID');
    const position = { at: parsed.data.timestamp, id: parsed.data.id };
    if (comparePosition(position, previous) <= 0)
      throw new ArchiveFailure('ARCHIVE_ROW_ORDER_INVALID');
    previous = position;
    return parsed.data;
  });
}

export type ArchiveKey = { id: string; key: CryptoKey };
export type Keyring = { current: ArchiveKey | null; keys: Map<string, CryptoKey> };

export async function importArchiveKey(id: string, base64: string): Promise<ArchiveKey> {
  if (!KEY_ID.test(id)) throw new Error('ARCHIVE_KEY_INVALID');
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(base64.trim()), (char) => char.charCodeAt(0));
  } catch {
    throw new Error('ARCHIVE_KEY_INVALID');
  }
  if (raw.length !== 32) throw new Error('ARCHIVE_KEY_INVALID');
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  raw.fill(0);
  return { id, key };
}

/**
 * AUDIT_ARCHIVE_KEY_ID + AUDIT_ARCHIVE_ENCRYPTION_KEY (32 random bytes, base64) encrypt new batches;
 * AUDIT_ARCHIVE_PREVIOUS_KEYS ("id=base64,id=base64") keeps rotated keys readable for verification.
 */
export async function loadKeyring(env: (name: string) => string | undefined): Promise<Keyring> {
  const keys = new Map<string, CryptoKey>();
  let current: ArchiveKey | null = null;
  const id = env('AUDIT_ARCHIVE_KEY_ID'),
    secret = env('AUDIT_ARCHIVE_ENCRYPTION_KEY');
  if (id || secret) {
    if (!id || !secret) throw new Error('ARCHIVE_KEY_INVALID');
    current = await importArchiveKey(id, secret);
    keys.set(current.id, current.key);
  }
  for (const entry of (env('AUDIT_ARCHIVE_PREVIOUS_KEYS') ?? '').split(',')) {
    if (!entry.trim()) continue;
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('ARCHIVE_KEY_INVALID');
    const previous = await importArchiveKey(
      entry.slice(0, separator).trim(),
      entry.slice(separator + 1),
    );
    if (!keys.has(previous.id)) keys.set(previous.id, previous.key);
  }
  return { current, keys };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Envelope: MAGIC | key-id length | key id | IV | AES-256-GCM ciphertext+tag; AAD = header + path. */
export async function encryptEnvelope(
  plaintext: Uint8Array,
  key: ArchiveKey,
  path: string,
): Promise<Uint8Array> {
  const id = encoder.encode(key.id),
    iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header = concat(MAGIC, new Uint8Array([id.length]), id, iv);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: concat(header, encoder.encode(path)) as BufferSource,
        tagLength: 128,
      },
      key.key,
      plaintext as BufferSource,
    ),
  );
  return concat(header, ciphertext);
}

export async function decryptEnvelope(
  bytes: Uint8Array,
  keys: Map<string, CryptoKey>,
  path: string,
): Promise<Uint8Array> {
  if (
    bytes.length < MAGIC.length + 2 + IV_BYTES + TAG_BYTES ||
    MAGIC.some((v, i) => bytes[i] !== v)
  )
    throw new ArchiveFailure('ARCHIVE_ENVELOPE_INVALID');
  const idLength = bytes[MAGIC.length]!,
    idStart = MAGIC.length + 1,
    ivStart = idStart + idLength,
    bodyStart = ivStart + IV_BYTES;
  if (idLength < 1 || bytes.length < bodyStart + TAG_BYTES)
    throw new ArchiveFailure('ARCHIVE_ENVELOPE_INVALID');
  const id = new TextDecoder().decode(bytes.subarray(idStart, ivStart));
  if (!KEY_ID.test(id)) throw new ArchiveFailure('ARCHIVE_ENVELOPE_INVALID');
  const key = keys.get(id);
  if (!key) throw new ArchiveFailure('ARCHIVE_KEY_UNAVAILABLE');
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.slice(ivStart, bodyStart) as BufferSource,
          additionalData: concat(
            bytes.subarray(0, bodyStart),
            encoder.encode(path),
          ) as BufferSource,
          tagLength: 128,
        },
        key,
        bytes.slice(bodyStart) as BufferSource,
      ),
    );
  } catch {
    throw new ArchiveFailure('ARCHIVE_DECRYPTION_FAILED');
  }
}

export type SealedBatch = {
  batchNo: number;
  path: string;
  bytes: Uint8Array;
  rowCount: number;
  endingAt: string;
  endingId: string;
  payloadSha256: string;
  plaintextSha256: string;
  chainSha256: string;
};

/** Builds the encrypted object and every value `finish_audit_archive_batch` re-checks. */
export async function sealBatch(input: {
  batchNo: number;
  previousChain: string;
  after: Position;
  rows: unknown[];
  key: ArchiveKey;
}): Promise<SealedBatch> {
  if (!HEX64.test(input.previousChain)) throw new Error('INVALID_ARCHIVE_HASH');
  const path = objectPath(input.batchNo),
    rows = validateRows(input.rows, input.after),
    last = rows.at(-1)!;
  const plaintext = encoder.encode(
    JSON.stringify({
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      batch_no: input.batchNo,
      previous_chain_sha256: input.previousChain,
      after: input.after,
      row_count: rows.length,
      ending_at: last.timestamp,
      ending_id: last.id.toLowerCase(),
      rows,
    }),
  );
  const bytes = await encryptEnvelope(plaintext, input.key, path);
  const payloadSha256 = await sha256Hex(bytes),
    plaintextSha256 = await sha256Hex(plaintext);
  return {
    batchNo: input.batchNo,
    path,
    bytes,
    rowCount: rows.length,
    endingAt: last.timestamp,
    endingId: last.id.toLowerCase(),
    payloadSha256,
    plaintextSha256,
    chainSha256: await chainSha256(
      input.previousChain,
      input.batchNo,
      payloadSha256,
      plaintextSha256,
      rows.length,
      last.id,
    ),
  };
}

export const checkpointSchema = z
  .object({
    batch_no: z.number().int().positive(),
    row_count: z.number().int().min(1).max(MAX_ROWS_PER_BATCH),
    plaintext_sha256: z.string().regex(HEX64),
    payload_sha256: z.string().regex(HEX64),
    previous_chain_sha256: z.string().regex(HEX64),
    chain_sha256: z.string().regex(HEX64),
    ending_at: z.string(),
    ending_id: z.string().regex(UUID),
    object_path: z.string(),
  })
  .passthrough();
export type Checkpoint = z.infer<typeof checkpointSchema>;

const documentSchema = z
  .object({
    format: z.literal(ARCHIVE_FORMAT),
    version: z.literal(ARCHIVE_VERSION),
    batch_no: z.number().int().positive(),
    previous_chain_sha256: z.string().regex(HEX64),
    after: z.object({ at: z.string(), id: z.string().regex(UUID) }),
    row_count: z.number().int().min(1).max(MAX_ROWS_PER_BATCH),
    ending_at: z.string(),
    ending_id: z.string().regex(UUID),
    rows: z.array(z.unknown()),
  })
  .strict();

/**
 * Recovers one archived batch from its object bytes alone and proves it matches the sealed
 * checkpoint: ciphertext hash, authenticated decryption, plaintext hash, contents and chain.
 */
export async function openBatch(
  bytes: Uint8Array,
  checkpoint: Checkpoint,
  keys: Map<string, CryptoKey>,
  expectedAfter: Position | null,
): Promise<{ rows: number }> {
  const path = objectPath(checkpoint.batch_no);
  if (checkpoint.object_path !== path) throw new ArchiveFailure('ARCHIVE_OBJECT_PATH_INVALID');
  if ((await sha256Hex(bytes)) !== checkpoint.payload_sha256)
    throw new ArchiveFailure('ARCHIVE_PAYLOAD_HASH_MISMATCH');
  const plaintext = await decryptEnvelope(bytes, keys, path);
  if ((await sha256Hex(plaintext)) !== checkpoint.plaintext_sha256)
    throw new ArchiveFailure('ARCHIVE_PLAINTEXT_HASH_MISMATCH');
  let document: z.infer<typeof documentSchema>;
  try {
    document = documentSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
    );
  } catch {
    throw new ArchiveFailure('ARCHIVE_CONTENT_INVALID');
  }
  const rows = validateRows(document.rows, document.after),
    last = rows.at(-1)!;
  if (
    document.batch_no !== checkpoint.batch_no ||
    document.previous_chain_sha256 !== checkpoint.previous_chain_sha256 ||
    document.row_count !== checkpoint.row_count ||
    rows.length !== checkpoint.row_count ||
    document.ending_id.toLowerCase() !== last.id.toLowerCase() ||
    document.ending_at !== last.timestamp ||
    comparePosition(
      { at: last.timestamp, id: last.id },
      { at: checkpoint.ending_at, id: checkpoint.ending_id },
    ) !== 0
  )
    throw new ArchiveFailure('ARCHIVE_CONTENT_MISMATCH');
  if (expectedAfter && comparePosition(document.after, expectedAfter) !== 0)
    throw new ArchiveFailure('ARCHIVE_RANGE_GAP');
  const chain = await chainSha256(
    checkpoint.previous_chain_sha256,
    checkpoint.batch_no,
    checkpoint.payload_sha256,
    checkpoint.plaintext_sha256,
    checkpoint.row_count,
    checkpoint.ending_id,
  );
  if (chain !== checkpoint.chain_sha256) throw new ArchiveFailure('ARCHIVE_CHAIN_INVALID');
  return { rows: rows.length };
}

/** A storage location; `download` resolves null only when the object does not exist. */
export type ArchiveStore = {
  name: 'PRIMARY' | 'REPLICA';
  upload(path: string, bytes: Uint8Array): Promise<void>;
  download(path: string): Promise<Uint8Array | null>;
};

export type VerificationResult = {
  pass: boolean;
  batches: number;
  rows: number;
  chain: string | null;
  failure: string | null;
};

/** Daily recovery test over the latest VERIFY_WINDOW batches, from every store. */
export async function verifyArchive(deps: {
  status(): Promise<{ last_batch: number; chain_sha256: string }>;
  checkpoints(after: number, limit: number): Promise<Checkpoint[]>;
  stores: ArchiveStore[];
  keys: Map<string, CryptoKey>;
}): Promise<VerificationResult> {
  let batches = 0,
    rows = 0;
  try {
    const status = await deps.status();
    if (status.last_batch < 1) throw new ArchiveFailure('NO_ARCHIVE_BATCHES');
    if (deps.keys.size === 0) throw new ArchiveFailure('ARCHIVE_KEY_NOT_CONFIGURED');
    const window = Math.min(status.last_batch, VERIFY_WINDOW),
      after = status.last_batch - window;
    let previousChain = ZERO_CHAIN,
      previousEnd: Position | null = null;
    if (after > 0) {
      const prior = (await deps.checkpoints(after - 1, 1))[0];
      if (!prior || prior.batch_no !== after)
        throw new ArchiveFailure('ARCHIVE_CHECKPOINTS_INCOMPLETE');
      previousChain = prior.chain_sha256;
      previousEnd = { at: prior.ending_at, id: prior.ending_id };
    }
    const checkpoints = await deps.checkpoints(after, window);
    if (checkpoints.length !== window || checkpoints.some((c, i) => c.batch_no !== after + i + 1))
      throw new ArchiveFailure('ARCHIVE_CHECKPOINTS_INCOMPLETE');
    for (const checkpoint of checkpoints) {
      if (checkpoint.previous_chain_sha256 !== previousChain)
        throw new ArchiveFailure('ARCHIVE_CHAIN_LINK_BROKEN');
      let recovered = 0;
      for (const store of deps.stores) {
        const bytes = await store.download(checkpoint.object_path);
        if (!bytes) throw new ArchiveFailure(`ARCHIVE_${store.name}_OBJECT_MISSING`);
        recovered = (await openBatch(bytes, checkpoint, deps.keys, previousEnd)).rows;
      }
      batches++;
      rows += recovered;
      previousChain = checkpoint.chain_sha256;
      previousEnd = { at: checkpoint.ending_at, id: checkpoint.ending_id };
    }
    if (previousChain !== status.chain_sha256)
      throw new ArchiveFailure('ARCHIVE_CHAIN_HEAD_MISMATCH');
    return { pass: true, batches, rows, chain: previousChain, failure: null };
  } catch (error) {
    return {
      pass: false,
      batches,
      rows,
      chain: null,
      failure: error instanceof ArchiveFailure ? error.code : 'ARCHIVE_VERIFICATION_ERROR',
    };
  }
}

const claimSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('BUSY') }).passthrough(),
  z.object({ status: z.literal('IDLE') }).passthrough(),
  z
    .object({
      status: z.literal('CLAIMED'),
      lease: z.uuid(),
      batch_no: z.number().int().positive(),
      last_at: z.string(),
      last_id: z.string().regex(UUID),
      previous_chain: z.string().regex(HEX64),
    })
    .passthrough(),
]);
const readSchema = z.object({ rows: z.array(z.unknown()), batch_no: z.number().int().positive() });
const finishSchema = z
  .object({
    status: z.literal('SEALED'),
    batch_no: z.number().int().positive(),
    chain_sha256: z.string().regex(HEX64),
  })
  .passthrough();

export type FinishArgs = {
  p_lease: string;
  p_ending_at: string;
  p_ending_id: string;
  p_row_count: number;
  p_payload_sha256: string;
  p_plaintext_sha256: string;
  p_chain_sha256: string;
  p_path: string;
};

export type RotationResult = {
  stopped: 'IDLE' | 'BUSY' | 'MAX_BATCHES' | 'TIME_BUDGET';
  batches_sealed: number;
  rows_archived: number;
  last_batch: number | null;
  chain_sha256: string | null;
};

/**
 * Seals up to `maxBatches` batches. Each one is written to every store and read back before the
 * checkpoint is sealed; on any failure the lease is released and the error propagates, so the
 * cursor never advances past rows that are not durably archived.
 */
export async function rotateArchive(deps: {
  claim(): Promise<unknown>;
  read(lease: string, limit: number): Promise<unknown>;
  finish(args: FinishArgs): Promise<unknown>;
  release(lease: string): Promise<void>;
  stores: ArchiveStore[];
  key: ArchiveKey;
  maxBatches: number;
  deadline: number;
  now(): number;
}): Promise<RotationResult> {
  const result: RotationResult = {
    stopped: 'MAX_BATCHES',
    batches_sealed: 0,
    rows_archived: 0,
    last_batch: null,
    chain_sha256: null,
  };
  if (deps.stores.length < 2) throw new Error('ARCHIVE_REPLICA_REQUIRED');
  for (let n = 0; n < deps.maxBatches; n++) {
    if (deps.now() > deps.deadline) {
      result.stopped = 'TIME_BUDGET';
      break;
    }
    const claim = claimSchema.parse(await deps.claim());
    if (claim.status !== 'CLAIMED') {
      result.stopped = claim.status;
      break;
    }
    try {
      const read = readSchema.parse(await deps.read(claim.lease, MAX_ROWS_PER_BATCH));
      if (read.batch_no !== claim.batch_no) throw new Error('ARCHIVE_BATCH_MISMATCH');
      if (read.rows.length === 0) {
        await deps.release(claim.lease);
        result.stopped = 'IDLE';
        break;
      }
      const sealed = await sealBatch({
        batchNo: claim.batch_no,
        previousChain: claim.previous_chain,
        after: { at: claim.last_at, id: claim.last_id },
        rows: read.rows,
        key: deps.key,
      });
      for (const store of deps.stores) {
        await store.upload(sealed.path, sealed.bytes);
        const readback = await store.download(sealed.path);
        if (!readback || (await sha256Hex(readback)) !== sealed.payloadSha256)
          throw new Error('ARCHIVE_READBACK_MISMATCH');
      }
      const finished = finishSchema.parse(
        await deps.finish({
          p_lease: claim.lease,
          p_ending_at: sealed.endingAt,
          p_ending_id: sealed.endingId,
          p_row_count: sealed.rowCount,
          p_payload_sha256: sealed.payloadSha256,
          p_plaintext_sha256: sealed.plaintextSha256,
          p_chain_sha256: sealed.chainSha256,
          p_path: sealed.path,
        }),
      );
      if (finished.batch_no !== sealed.batchNo || finished.chain_sha256 !== sealed.chainSha256)
        throw new Error('ARCHIVE_SEAL_MISMATCH');
      result.batches_sealed++;
      result.rows_archived += sealed.rowCount;
      result.last_batch = finished.batch_no;
      result.chain_sha256 = finished.chain_sha256;
    } catch (error) {
      await deps.release(claim.lease).catch(() => undefined);
      throw error;
    }
  }
  return result;
}
