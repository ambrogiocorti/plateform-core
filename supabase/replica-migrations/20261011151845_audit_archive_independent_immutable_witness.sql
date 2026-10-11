-- Independent, append-only audit archive witness in the backup replica project.
CREATE TABLE IF NOT EXISTS private.audit_archive_witness (
  batch_no bigint PRIMARY KEY CHECK (batch_no>0),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  plaintext_sha256 text NOT NULL CHECK (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
  previous_chain_sha256 text NOT NULL CHECK (previous_chain_sha256 ~ '^[0-9a-f]{64}$'),
  chain_sha256 text NOT NULL CHECK (chain_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 500),
  upper_event_id uuid NOT NULL,
  object_path text NOT NULL UNIQUE,
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 2097152),
  attested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE private.audit_archive_witness ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.audit_archive_witness FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.audit_archive_witness_no_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN RAISE EXCEPTION 'AUDIT_ARCHIVE_WITNESS_IMMUTABLE'; END $fn$;
REVOKE ALL ON FUNCTION private.audit_archive_witness_no_change() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS audit_archive_witness_immutable ON private.audit_archive_witness;
CREATE TRIGGER audit_archive_witness_immutable BEFORE UPDATE OR DELETE ON private.audit_archive_witness
FOR EACH ROW EXECUTE FUNCTION private.audit_archive_witness_no_change();

CREATE OR REPLACE FUNCTION public.attest_audit_archive_replica(
 p_batch_no bigint,p_payload_sha256 text,p_plaintext_sha256 text,
 p_previous_chain text,p_chain text,p_row_count integer,p_upper_event_id uuid,
 p_object_path text,p_byte_count integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE last_batch bigint; last_chain text; previous private.audit_archive_witness;
DECLARE expected text;
BEGIN
 IF p_batch_no IS NULL OR p_batch_no NOT BETWEEN 1 AND 100000000
 OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
 OR p_plaintext_sha256 !~ '^[0-9a-f]{64}$'
 OR p_previous_chain !~ '^[0-9a-f]{64}$'
 OR p_chain !~ '^[0-9a-f]{64}$'
 OR p_row_count NOT BETWEEN 1 AND 500 OR p_upper_event_id IS NULL
 OR p_object_path IS NULL OR p_object_path <> ('v1/batch-'||lpad(p_batch_no::text,9,'0')||'.bin')
 OR p_byte_count NOT BETWEEN 1 AND 2097152 THEN
  RAISE EXCEPTION 'AUDIT_ARCHIVE_WITNESS_INVALID';
 END IF;
 expected:=encode(extensions.digest(
 (p_previous_chain||':'||p_batch_no||':'||p_payload_sha256||':'||
 p_plaintext_sha256||':'||p_row_count||':'||p_upper_event_id)::bytea,'sha256'),'hex');
 IF expected<>p_chain THEN RAISE EXCEPTION 'AUDIT_ARCHIVE_CHAIN_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(834785918);
 SELECT * INTO previous FROM private.audit_archive_witness WHERE batch_no=p_batch_no;
 IF FOUND THEN
  IF previous.chain_sha256=p_chain AND previous.payload_sha256=p_payload_sha256
  AND previous.plaintext_sha256=p_plaintext_sha256
  AND previous.row_count=p_row_count AND previous.upper_event_id=p_upper_event_id
  AND previous.object_path=p_object_path AND previous.byte_count=p_byte_count THEN
   RETURN true;
  END IF;
  RAISE EXCEPTION 'AUDIT_ARCHIVE_WITNESS_CONFLICT';
 END IF;
 SELECT batch_no,chain_sha256 INTO last_batch,last_chain
 FROM private.audit_archive_witness ORDER BY batch_no DESC LIMIT 1;
 IF p_batch_no IS DISTINCT FROM coalesce(last_batch,0)+1
 OR p_previous_chain IS DISTINCT FROM coalesce(last_chain,repeat('0',64)) THEN
  RAISE EXCEPTION 'AUDIT_ARCHIVE_WITNESS_SEQUENCE_GAP';
 END IF;
 INSERT INTO private.audit_archive_witness
 (batch_no,payload_sha256,plaintext_sha256,previous_chain_sha256,chain_sha256,
 row_count,upper_event_id,object_path,byte_count)
 VALUES(p_batch_no,p_payload_sha256,p_plaintext_sha256,p_previous_chain,p_chain,
 p_row_count,p_upper_event_id,p_object_path,p_byte_count);
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.attest_audit_archive_replica(bigint,text,text,text,text,integer,uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.attest_audit_archive_replica(bigint,text,text,text,text,integer,uuid,text,integer) TO service_role;
