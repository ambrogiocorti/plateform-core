// Supabase-managed surface for a disposable PostgreSQL 16: the same fixture the
// PGlite database tests use (tests/database/harness.ts), plus the managed Auth
// and Storage columns/tables that the continuity workers read. It simulates an
// EMPTY Supabase project; it does not emulate GoTrue, the Storage service or
// Vault encryption.
import { readFile } from 'node:fs/promises';

const MANAGED_EXTRAS = `
alter table auth.users add column if not exists encrypted_password text;
alter table auth.users add column if not exists created_at timestamptz default now();
create table if not exists auth.refresh_tokens(id bigserial primary key,token text,user_id text,session_id uuid,revoked boolean default false);
create table if not exists auth.flow_state(id uuid primary key);
create table if not exists auth.mfa_amr_claims(id uuid primary key,session_id uuid);
create table if not exists auth.mfa_challenges(id uuid primary key);
create table if not exists auth.oauth_authorizations(id uuid primary key);
create table if not exists auth.oauth_client_states(id uuid primary key);
create table if not exists auth.one_time_tokens(id uuid primary key,user_id uuid);
create table if not exists auth.saml_relay_states(id uuid primary key);
create table if not exists auth.webauthn_challenges(id uuid primary key);
alter table storage.buckets add column if not exists owner uuid;
alter table storage.buckets add column if not exists owner_id text;
alter table storage.buckets add column if not exists avif_autodetection boolean default false;
alter table storage.buckets add column if not exists type text not null default 'STANDARD';
alter table storage.buckets add column if not exists versioning_status text;
alter table storage.buckets add column if not exists lifecycle_configuration jsonb;
alter table storage.buckets add column if not exists lifecycle_configuration_generation bigint;
alter table storage.objects add column if not exists owner uuid;
alter table storage.objects add column if not exists owner_id text;
alter table storage.objects add column if not exists path_tokens text[];
alter table storage.objects add column if not exists user_metadata jsonb;
alter table storage.objects add column if not exists archived_at timestamptz;
alter table storage.objects add column if not exists is_delete_marker boolean default false;
alter table storage.objects add column if not exists is_versioned boolean default false;
create unique index if not exists objects_bucket_name on storage.objects(bucket_id,name);
`;

export async function platformPrelude(repoRoot, { migrationHistory = true } = {}) {
  // Shared Supabase host fixture (also used by PGlite and the PostgreSQL replay).
  // Its role creation is already idempotent for a real cluster.
  let sql = await readFile(new URL('supabase/tests/host-fixture.sql', repoRoot), 'utf8');
  if (!migrationHistory) {
    // A brand-new Supabase project has no migration history yet: the backup
    // restores supabase_migrations from its own history artifacts.
    sql = sql.replace(
      /create schema supabase_migrations;\s*create table supabase_migrations\.schema_migrations\([^;]*\);/,
      '',
    );
    if (sql.includes('supabase_migrations')) throw new Error('HARNESS_HISTORY_FIXTURE_CHANGED');
  }
  return `create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
${sql}
${MANAGED_EXTRAS}`;
}

export const SUPABASE_PREFIX = /^(\d{14})_(.+)\.sql$/;
