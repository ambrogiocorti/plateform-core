-- RECOVERY BRIDGE (authored 2026-10-10, retro-ordered intentionally).
-- Historical remote migration 20261006100248 hardens seven rehearsal tables
-- that existed on Development but were never created by any of its 457
-- recorded SQL migrations.  Keep ALL 457 canonical SQL files unchanged.
-- This corrective migration precedes that historical hardening, and is a
-- no-op for existing tables in Development.  It contains schema only:
-- no customer records, tokens, encryption keys or historical artifacts.
-- Review and test independently before promoting to another environment.
begin;

create table if not exists private.continuity_rehearsal_blob (
  snapshot_id uuid primary key,
  row_count bigint not null,
  table_count integer not null,
  plaintext_sha256 text not null,
  cipher bytea not null,
  created_at timestamptz not null default now()
);

create table if not exists private.continuity_rehearsal_key (
  id boolean primary key default true check (id),
  key_material text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now()
);

create table if not exists private.continuity_rehearsal_snapshot_manifest (
  snapshot_id uuid primary key,
  created_at timestamptz not null default now(),
  migration_count integer not null,
  migration_latest_version text not null,
  migration_aggregate_sha256 text not null,
  auth_user_count bigint not null,
  durable_private_row_count bigint not null,
  durable_private_sha256 text not null,
  table_count integer not null,
  row_count bigint not null,
  storage_bucket_count bigint not null,
  storage_object_count bigint not null,
  status text not null default 'FROZEN'
);

create table if not exists private.continuity_rehearsal_snapshot_rows (
  snapshot_id uuid not null,
  schema_name text not null,
  table_name text not null,
  row_no bigint not null,
  row_data jsonb not null,
  constraint continuity_rehearsal_snapshot_rows_pkey primary key (snapshot_id, schema_name, table_name, row_no),
  constraint continuity_rehearsal_snapshot_rows_snapshot_id_fkey
    foreign key (snapshot_id)
    references private.continuity_rehearsal_snapshot_manifest(snapshot_id) on delete cascade
);

create table if not exists private.continuity_rehearsal_snapshot_tables (
  snapshot_id uuid not null,
  schema_name text not null,
  table_name text not null,
  row_count bigint not null,
  data_sha256 text not null,
  insert_columns text[] not null,
  has_identity_always boolean not null,
  generated_columns text[] not null,
  constraint continuity_rehearsal_snapshot_tables_pkey primary key (snapshot_id, schema_name, table_name)
);

create table if not exists private.continuity_rehearsal_transfer_chunks (
  snapshot_id uuid not null,
  chunk_no integer not null,
  row_count integer not null,
  plaintext_sha256 text not null,
  ciphertext bytea not null,
  created_at timestamptz not null default now(),
  constraint continuity_rehearsal_transfer_chunks_pkey primary key (snapshot_id, chunk_no)
);

create table if not exists private.continuity_rehearsal_transfer_key (
  snapshot_id uuid primary key,
  encryption_key text not null,
  created_at timestamptz not null default now()
);

-- Fail closed on exposed roles even before the next canonical RLS hardening.
alter table private.continuity_rehearsal_blob enable row level security;
alter table private.continuity_rehearsal_key enable row level security;
alter table private.continuity_rehearsal_snapshot_manifest enable row level security;
alter table private.continuity_rehearsal_snapshot_rows enable row level security;
alter table private.continuity_rehearsal_snapshot_tables enable row level security;
alter table private.continuity_rehearsal_transfer_chunks enable row level security;
alter table private.continuity_rehearsal_transfer_key enable row level security;
revoke all on private.continuity_rehearsal_blob from public, anon, authenticated;
revoke all on private.continuity_rehearsal_key from public, anon, authenticated;
revoke all on private.continuity_rehearsal_snapshot_manifest from public, anon, authenticated;
revoke all on private.continuity_rehearsal_snapshot_rows from public, anon, authenticated;
revoke all on private.continuity_rehearsal_snapshot_tables from public, anon, authenticated;
revoke all on private.continuity_rehearsal_transfer_chunks from public, anon, authenticated;
revoke all on private.continuity_rehearsal_transfer_key from public, anon, authenticated;

commit;
