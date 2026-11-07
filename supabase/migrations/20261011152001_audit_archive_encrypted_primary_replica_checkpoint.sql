-- Bounded audit archive queue; no retention, deletions or modification of audit_log.
CREATE TABLE IF NOT EXISTS private.audit_archive_cursor (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 last_event_at timestamptz NOT NULL DEFAULT '2000-01-01T00:00:00Z',
 last_event_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 last_batch bigint NOT NULL DEFAULT 0,
 last_chain_sha256 text NOT NULL DEFAULT repeat('0',64),
 lease_token uuid,
 lease_expires_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE private.audit_archive_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.audit_archive_cursor FROM PUBLIC,anon,authenticated;
INSERT INTO private.audit_archive_cursor(id) VALUES(true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS private.audit_archive_batches (
 batch_no bigint PRIMARY KEY CHECK (batch_no>0),
 starting_at timestamptz NOT NULL,
 starting_id uuid NOT NULL,
 ending_at timestamptz NOT NULL,
 ending_id uuid NOT NULL,
 row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 500),
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 plaintext_sha256 text NOT NULL CHECK(plaintext_sha256 ~ '^[0-9a-f]{64}$'),
 previous_chain_sha256 text NOT NULL CHECK(previous_chain_sha256 ~ '^[0-9a-f]{64}$'),
 chain_sha256 text NOT NULL CHECK(chain_sha256 ~ '^[0-9a-f]{64}$'),
 object_path text NOT NULL UNIQUE,
 sealed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE private.audit_archive_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.audit_archive_batches FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.audit_archive_batch_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN RAISE EXCEPTION 'AUDIT_ARCHIVE_CHECKPOINT_IMMUTABLE'; END $fn$;
REVOKE ALL ON FUNCTION private.audit_archive_batch_immutable() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS audit_archive_batch_immutable ON private.audit_archive_batches;
CREATE TRIGGER audit_archive_batch_immutable
 BEFORE UPDATE OR DELETE ON private.audit_archive_batches
 FOR EACH ROW EXECUTE FUNCTION private.audit_archive_batch_immutable();

CREATE OR REPLACE FUNCTION public.claim_audit_archive_batch()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE state private.audit_archive_cursor; token uuid;
BEGIN
 SELECT * INTO state FROM private.audit_archive_cursor WHERE id FOR UPDATE;
 IF state.lease_expires_at IS NOT NULL AND state.lease_expires_at>clock_timestamp()
 THEN RETURN jsonb_build_object('status','BUSY');END IF;
 IF NOT EXISTS (
 SELECT 1 FROM public.audit_log a WHERE (a.timestamp,a.id)>(state.last_event_at,state.last_event_id)
   AND a.timestamp < now()-interval '5 minutes'
 ) THEN RETURN jsonb_build_object('status','IDLE','last_batch',state.last_batch);END IF;
 token:=gen_random_uuid();
 UPDATE private.audit_archive_cursor SET lease_token=token,
 lease_expires_at=clock_timestamp()+interval '15 minutes',updated_at=clock_timestamp() WHERE id;
 RETURN jsonb_build_object('status','CLAIMED','lease',token,'batch_no',state.last_batch+1,
 'last_at',state.last_event_at,'last_id',state.last_event_id,
 'previous_chain',state.last_chain_sha256);
END $fn$;
REVOKE ALL ON FUNCTION public.claim_audit_archive_batch() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_audit_archive_batch() TO service_role;

CREATE OR REPLACE FUNCTION public.read_audit_archive_batch(p_lease uuid,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE state private.audit_archive_cursor;result jsonb;
BEGIN
 IF p_lease IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'INVALID_ARCHIVE_BATCH_REQUEST'; END IF;
 SELECT * INTO state FROM private.audit_archive_cursor WHERE id;
 IF state.lease_token IS DISTINCT FROM p_lease OR state.lease_expires_at<clock_timestamp()
 THEN RAISE EXCEPTION 'AUDIT_ARCHIVE_LEASE_REQUIRED'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(a) - 'metadata' - 'ip_address' - 'user_agent'
  - 'authorization_context' ORDER BY a.timestamp,a.id),'[]'::jsonb) INTO result
 FROM (
 SELECT * FROM public.audit_log a
 WHERE (a.timestamp,a.id)>(state.last_event_at,state.last_event_id)
   AND a.timestamp<now()-interval '5 minutes'
 ORDER BY a.timestamp,a.id LIMIT p_limit
 ) a;
 RETURN jsonb_build_object('rows',result,'batch_no',state.last_batch+1);
END $fn$;
REVOKE ALL ON FUNCTION public.read_audit_archive_batch(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_audit_archive_batch(uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_audit_archive_batch(
 p_lease uuid,p_ending_at timestamptz,p_ending_id uuid,p_row_count integer,
 p_payload_sha256 text,p_plaintext_sha256 text,p_chain_sha256 text,p_path text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE st private.audit_archive_cursor; actual_count integer;actual_last_at timestamptz;
DECLARE actual_last_id uuid;expected text;seq bigint;
BEGIN
 IF p_lease IS NULL OR p_ending_at IS NULL OR p_ending_id IS NULL
 OR p_row_count IS NULL OR p_row_count NOT BETWEEN 1 AND 500
 OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
 OR p_plaintext_sha256 !~ '^[0-9a-f]{64}$'
 OR p_chain_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_ARCHIVE_COMPLETION'; END IF;
 SELECT * INTO st FROM private.audit_archive_cursor WHERE id FOR UPDATE;
 IF st.lease_token IS DISTINCT FROM p_lease OR st.lease_expires_at<clock_timestamp()
 THEN RAISE EXCEPTION 'AUDIT_ARCHIVE_LEASE_EXPIRED'; END IF;
 seq:=st.last_batch+1;
 IF p_path IS DISTINCT FROM ('v1/batch-'||lpad(seq::text,9,'0')||'.bin')
 OR (p_ending_at,p_ending_id)<=(st.last_event_at,st.last_event_id)
 OR p_ending_at>=now()-interval '5 minutes' THEN RAISE EXCEPTION 'INVALID_ARCHIVE_RANGE'; END IF;
 SELECT count(*),max(timestamp) INTO actual_count,actual_last_at FROM public.audit_log a
 WHERE (a.timestamp,a.id)>(st.last_event_at,st.last_event_id)
 AND (a.timestamp,a.id)<=(p_ending_at,p_ending_id);
 SELECT id INTO actual_last_id FROM public.audit_log a
 WHERE (a.timestamp,a.id)>(st.last_event_at,st.last_event_id)
 AND (a.timestamp,a.id)<=(p_ending_at,p_ending_id)
 ORDER BY timestamp DESC,id DESC LIMIT 1;
 IF actual_count<>p_row_count OR actual_last_at IS DISTINCT FROM p_ending_at
 OR actual_last_id IS DISTINCT FROM p_ending_id THEN RAISE EXCEPTION 'ARCHIVE_ROW_COUNT_CHANGED'; END IF;
 expected:=encode(extensions.digest((
 st.last_chain_sha256||':'||seq||':'||p_payload_sha256||':'||
 p_plaintext_sha256||':'||p_row_count||':'||p_ending_id)::bytea,'sha256'),'hex');
 IF expected<>p_chain_sha256 THEN RAISE EXCEPTION 'AUDIT_ARCHIVE_CHAIN_INVALID'; END IF;
 INSERT INTO private.audit_archive_batches
 (batch_no,starting_at,starting_id,ending_at,ending_id,row_count,payload_sha256,
 plaintext_sha256,previous_chain_sha256,chain_sha256,object_path)
 VALUES(seq,st.last_event_at,st.last_event_id,p_ending_at,p_ending_id,p_row_count,
 p_payload_sha256,p_plaintext_sha256,st.last_chain_sha256,p_chain_sha256,p_path);
 UPDATE private.audit_archive_cursor SET
 last_event_at=p_ending_at,last_event_id=p_ending_id,last_batch=seq,
 last_chain_sha256=p_chain_sha256,lease_token=NULL,lease_expires_at=NULL,
 updated_at=clock_timestamp() WHERE id;
 RETURN jsonb_build_object('status','SEALED','batch_no',seq,'chain_sha256',p_chain_sha256,'rows',p_row_count);
END $fn$;
REVOKE ALL ON FUNCTION public.finish_audit_archive_batch(uuid,timestamptz,uuid,integer,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_audit_archive_batch(uuid,timestamptz,uuid,integer,text,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.audit_archive_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT jsonb_build_object('last_batch',s.last_batch,'last_at',s.last_event_at,
 'last_id',s.last_event_id,'chain_sha256',s.last_chain_sha256,
 'archived_rows',(SELECT coalesce(sum(row_count),0) FROM private.audit_archive_batches),
 'remaining_rows',(SELECT count(*) FROM public.audit_log a
 WHERE (a.timestamp,a.id)>(s.last_event_at,s.last_event_id)),
 'lease_active',coalesce(s.lease_expires_at>now(),false))
 FROM private.audit_archive_cursor s WHERE s.id
$fn$;
REVOKE ALL ON FUNCTION public.audit_archive_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.audit_archive_status() TO service_role;

CREATE OR REPLACE FUNCTION public.release_empty_audit_archive(p_lease uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 UPDATE private.audit_archive_cursor SET lease_token=NULL,lease_expires_at=NULL,
 updated_at=clock_timestamp() WHERE id AND lease_token=p_lease;
 RETURN FOUND;
END $fn$;
REVOKE ALL ON FUNCTION public.release_empty_audit_archive(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.release_empty_audit_archive(uuid) TO service_role;
