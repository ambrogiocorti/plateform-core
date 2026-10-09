-- Clean-install bootstrap v1. Catalog verified on Development, 2026-10-09.
-- Production data, rehearsal payloads and encryption keys are never seeded.
-- Only an EMPTY application schema is supported. Existing installations use
-- forward migrations and MUST NOT execute this bootstrap.
begin;
do $bootstrap$
declare history_exists boolean;
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p','v','m','S')
      and not exists(select 1 from pg_depend d
        where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
  ) then
    raise exception 'CLEAN_INSTALL_REQUIRES_EMPTY_APPLICATION_SCHEMAS';
  end if;
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select exists(select 1 from supabase_migrations.schema_migrations)' into history_exists;
    if history_exists then
      raise exception 'CLEAN_INSTALL_REQUIRES_EMPTY_MIGRATION_HISTORY';
    end if;
  end if;
end
$bootstrap$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
create table private.continuity_rehearsal_blob (
  snapshot_id uuid primary key,
  row_count bigint not null,
  table_count integer not null,
  plaintext_sha256 text not null,
  cipher bytea not null,
  created_at timestamptz not null default now()
);
create table private.continuity_rehearsal_key (
  id boolean primary key default true check (id),
  key_material text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now()
);
create table private.continuity_rehearsal_snapshot_manifest (
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
create table private.continuity_rehearsal_snapshot_rows (
  snapshot_id uuid not null references
    private.continuity_rehearsal_snapshot_manifest(snapshot_id) on delete cascade,
  schema_name text not null,
  table_name text not null,
  row_no bigint not null,
  row_data jsonb not null,
  primary key (snapshot_id, schema_name, table_name, row_no)
);
create table private.continuity_rehearsal_snapshot_tables (
  snapshot_id uuid not null,
  schema_name text not null,
  table_name text not null,
  row_count bigint not null,
  data_sha256 text not null,
  insert_columns text[] not null,
  has_identity_always boolean not null,
  generated_columns text[] not null,
  primary key (snapshot_id, schema_name, table_name)
);
create table private.continuity_rehearsal_transfer_chunks (
  snapshot_id uuid not null,
  chunk_no integer not null,
  row_count integer not null,
  plaintext_sha256 text not null,
  ciphertext bytea not null,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, chunk_no)
);
create table private.continuity_rehearsal_transfer_key (
  snapshot_id uuid primary key,
  encryption_key text not null,
  created_at timestamptz not null default now()
);
        
alter table private.continuity_rehearsal_blob enable row level security;
revoke all on private.continuity_rehearsal_blob from public,anon,authenticated,service_role;
alter table private.continuity_rehearsal_key enable row level security;
revoke all on private.continuity_rehearsal_key from public,anon,authenticated,service_role;
alter table private.continuity_rehearsal_snapshot_manifest enable row level security;
revoke all on private.continuity_rehearsal_snapshot_manifest from public,anon,authenticated,service_role;
alter table private.continuity_rehearsal_snapshot_rows enable row level security;
revoke all on private.continuity_rehearsal_snapshot_rows from public,anon,authenticated,service_role;
alter table private.continuity_rehearsal_snapshot_tables enable row level security;
revoke all on private.continuity_rehearsal_snapshot_tables from public,anon,authenticated,service_role;
alter table private.continuity_rehearsal_transfer_chunks enable row level security;
revoke all on private.continuity_rehearsal_transfer_chunks from public,anon,authenticated,service_role;
alter table private.continuity_rehearsal_transfer_key enable row level security;
revoke all on private.continuity_rehearsal_transfer_key from public,anon,authenticated,service_role;
commit;
