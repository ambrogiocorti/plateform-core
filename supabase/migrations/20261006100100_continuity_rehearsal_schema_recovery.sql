-- Prospective bootstrap repair. Recovered historic SQL remains byte-immutable.
-- In new installations this MUST run before 20261006100248, which references
-- seven tables previously created only by an out-of-band Development action.
-- Safe on an existing installation: no rows are touched or replaced.
BEGIN;

CREATE TABLE IF NOT EXISTS private.continuity_rehearsal_blob (
  snapshot_id uuid PRIMARY KEY,
  row_count bigint NOT NULL,
  table_count integer NOT NULL,
  plaintext_sha256 text NOT NULL,
  cipher bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.continuity_rehearsal_key (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  key_material text NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.continuity_rehearsal_snapshot_manifest (
  snapshot_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  migration_count integer NOT NULL,
  migration_latest_version text NOT NULL,
  migration_aggregate_sha256 text NOT NULL,
  auth_user_count bigint NOT NULL,
  durable_private_row_count bigint NOT NULL,
  durable_private_sha256 text NOT NULL,
  table_count integer NOT NULL,
  row_count bigint NOT NULL,
  storage_bucket_count bigint NOT NULL,
  storage_object_count bigint NOT NULL,
  status text NOT NULL DEFAULT 'FROZEN'
);
CREATE TABLE IF NOT EXISTS private.continuity_rehearsal_snapshot_rows (
  snapshot_id uuid NOT NULL REFERENCES private.continuity_rehearsal_snapshot_manifest(snapshot_id) ON DELETE CASCADE,
  schema_name text NOT NULL,
  table_name text NOT NULL,
  row_no bigint NOT NULL,
  row_data jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, schema_name, table_name, row_no)
);
CREATE TABLE IF NOT EXISTS private.continuity_rehearsal_snapshot_tables (
  snapshot_id uuid NOT NULL,
  schema_name text NOT NULL,
  table_name text NOT NULL,
  row_count bigint NOT NULL,
  data_sha256 text NOT NULL,
  insert_columns text[] NOT NULL,
  has_identity_always boolean NOT NULL,
  generated_columns text[] NOT NULL,
  PRIMARY KEY (snapshot_id, schema_name, table_name)
);
CREATE TABLE IF NOT EXISTS private.continuity_rehearsal_transfer_chunks (
  snapshot_id uuid NOT NULL,
  chunk_no integer NOT NULL,
  row_count integer NOT NULL,
  plaintext_sha256 text NOT NULL,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, chunk_no)
);
CREATE TABLE IF NOT EXISTS private.continuity_rehearsal_transfer_key (
  snapshot_id uuid PRIMARY KEY,
  encryption_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.continuity_rehearsal_blob ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.continuity_rehearsal_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.continuity_rehearsal_snapshot_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.continuity_rehearsal_snapshot_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.continuity_rehearsal_snapshot_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.continuity_rehearsal_transfer_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.continuity_rehearsal_transfer_key ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  private.continuity_rehearsal_blob,
  private.continuity_rehearsal_key,
  private.continuity_rehearsal_snapshot_manifest,
  private.continuity_rehearsal_snapshot_rows,
  private.continuity_rehearsal_snapshot_tables,
  private.continuity_rehearsal_transfer_chunks,
  private.continuity_rehearsal_transfer_key
FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
