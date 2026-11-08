import type { PGlite } from '@electric-sql/pglite';

// Cloud-side application of the hub change log. The replica stores, per hub,
// the highest applied sequence and authority generation:
//  - a batch is applied in one transaction, in seq order, skipping seq <= last;
//  - a batch from an older generation than the one already accepted is refused
//    (fencing), so a deposed hub can never overwrite the promoted one;
//  - business triggers are not re-executed on the replica: the hub already ran
//    them and its resulting rows (including audit) are replicated as data.
// This module is the reference implementation exercised against an embedded
// PostgreSQL. The hosted Supabase ingest (Edge Function + service-only RPC) must
// keep exactly these semantics; see the ADR for the hosted constraints.

export type Change = {
  seq: number;
  generation: number;
  table_name: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  pk: Record<string, unknown>;
  row_data: Record<string, unknown> | null;
};

export const REPLICA_STATE_SQL = `
create schema if not exists hub_replica;
revoke all on schema hub_replica from public, anon, authenticated;
create table if not exists hub_replica.state(
  hub_id text primary key,
  generation integer not null,
  applied_seq bigint not null default 0,
  updated_at timestamptz not null default now()
);
`;

export class ReplicaFenced extends Error {
  constructor() {
    super('HUB_GENERATION_FENCED');
  }
}

const IDENT = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

export async function applyBatch(replica: PGlite, hubId: string, batch: Change[]) {
  if (batch.length === 0) return { applied: 0, last: null as number | null };
  const generation = batch[0]!.generation;
  if (batch.some((c) => c.generation !== generation)) throw new Error('MIXED_GENERATION_BATCH');
  return replica.transaction(async (tx) => {
    await tx.exec(REPLICA_STATE_SQL);
    const state = (
      await tx.query<{ generation: number; applied_seq: string }>(
        'select generation, applied_seq::text from hub_replica.state where hub_id = $1 for update',
        [hubId],
      )
    ).rows[0];
    if (state && generation < state.generation) throw new ReplicaFenced();
    // A new generation restarts nothing: seq is global to the hub data directory.
    const last = state ? Number(state.applied_seq) : 0;
    await tx.exec(`set local session_replication_role = replica`);
    let applied = 0;
    for (const change of batch.sort((a, b) => a.seq - b.seq)) {
      if (change.seq <= last) continue;
      if (!IDENT.test(change.table_name)) throw new Error('INVALID_TABLE');
      const columns = (
        await tx.query<{ name: string; generated: string; identity: string }>(
          `select a.attname as name, a.attgenerated as generated, a.attidentity as identity
           from pg_attribute a
           where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped`,
          [change.table_name],
        )
      ).rows.filter((c) => c.generated === '');
      const pkCols = Object.keys(change.pk);
      if (pkCols.length === 0) throw new Error('MISSING_PRIMARY_KEY');
      const q = (n: string) => `"${n.replaceAll('"', '""')}"`;
      if (change.op === 'DELETE') {
        const where = pkCols.map((c, i) => `${q(c)} = $${i + 1}`).join(' and ');
        await tx.query(
          `delete from ${change.table_name} where ${where}`,
          pkCols.map((c) => change.pk[c]),
        );
      } else {
        const names = columns.map((c) => q(c.name)).join(',');
        const updates = columns
          .filter((c) => !pkCols.includes(c.name))
          .map((c) => `${q(c.name)} = excluded.${q(c.name)}`)
          .join(',');
        const overriding = columns.some((c) => c.identity === 'a')
          ? ' overriding system value'
          : '';
        await tx.query(
          `insert into ${change.table_name}(${names})${overriding}
           select ${names} from jsonb_populate_record(null::${change.table_name}, $1::jsonb)
           on conflict (${pkCols.map(q).join(',')}) do ${updates ? `update set ${updates}` : 'nothing'}`,
          [JSON.stringify(change.row_data)],
        );
      }
      applied += 1;
    }
    const top = Math.max(last, ...batch.map((c) => c.seq));
    await tx.query(
      `insert into hub_replica.state(hub_id, generation, applied_seq) values($1,$2,$3)
       on conflict (hub_id) do update set generation = excluded.generation,
         applied_seq = greatest(hub_replica.state.applied_seq, excluded.applied_seq), updated_at = now()`,
      [hubId, generation, top],
    );
    return { applied, last: top };
  });
}

// Explicit administrative promotion of a replacement hub on the cloud side.
// Monotonic: the recorded generation can only increase. After promotion any
// batch from an older generation is refused, even if it carries new seq values.
export async function promoteGeneration(replica: PGlite, hubId: string, generation: number) {
  await replica.transaction(async (tx) => {
    await tx.exec(REPLICA_STATE_SQL);
    await tx.query(
      `insert into hub_replica.state(hub_id, generation) values($1,$2)
       on conflict (hub_id) do update set generation = greatest(hub_replica.state.generation, excluded.generation),
         updated_at = now()`,
      [hubId, generation],
    );
  });
}
