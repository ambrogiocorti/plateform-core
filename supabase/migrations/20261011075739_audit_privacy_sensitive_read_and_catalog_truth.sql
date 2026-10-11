-- Audit every authorized access to reservation contact search results without logging
-- the phone number, names, search terms or returned personal data.
CREATE OR REPLACE FUNCTION public.search_privacy_reservations(
 p_venue uuid,p_phone text,p_after uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO ''
AS $body$
DECLARE v_results jsonb;
BEGIN
 PERFORM private.authorize(p_venue,array['ADMIN']::public.user_role[],false);
 IF p_phone IS NULL OR length(trim(p_phone)) NOT BETWEEN 5 AND 50
 THEN RAISE EXCEPTION 'INVALID_SEARCH'; END IF;

 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO v_results
 FROM (
   SELECT id,venue_id,first_name,last_name,phone,service_date,slot_time,
          status,version,anonymized_at,privacy_hold,privacy_hold_reason
   FROM public.reservations
   WHERE (p_venue IS NULL OR venue_id=p_venue)
     AND private.has_venue(venue_id)
     AND phone=trim(p_phone)
     AND (p_after IS NULL OR id>p_after)
   ORDER BY id LIMIT 51
 ) r;

 -- Authoritative server-side event, same transaction as the sensitive read.
 -- Purpose is allowlisted, no phone numbers or result payload enter the audit.
 PERFORM private.audit(
   'SENSITIVE_DATA_ACCESS','reservation_privacy_search',NULL,p_venue,NULL,
   jsonb_build_object('purpose','AUTHORIZED_CONTACT_LOOKUP')
 );
 RETURN v_results;
END $body$;

-- Distinguish proven live occurrences from implemented but not yet observed sources.
ALTER TABLE private.audit_event_catalog
 DROP CONSTRAINT IF EXISTS audit_event_catalog_implementation_status_check;
ALTER TABLE private.audit_event_catalog
 ADD CONSTRAINT audit_event_catalog_implementation_status_check
 CHECK (implementation_status IN ('OBSERVED','IMPLEMENTED','PLANNED'));

UPDATE private.audit_event_catalog
SET implementation_status='IMPLEMENTED',category='PRIVACY',
 severity='ELEVATED',retention_class='SECURITY',
 label_it='Ricerca autorizzata di contatti delle prenotazioni'
WHERE action='SENSITIVE_DATA_ACCESS' AND implementation_status='PLANNED';

INSERT INTO private.audit_event_catalog
(action,category,severity,retention_class,label_it,requires_reason,requires_approval,implementation_status)
VALUES
('PERSONAL_DATA_EXPORTED','PRIVACY','CRITICAL','SECURITY',
 'Dati personali della prenotazione esportati',true,true,'IMPLEMENTED'),
('PERSONAL_DATA_RECTIFY','PRIVACY','ELEVATED','SECURITY',
 'Dati personali della prenotazione rettificati',true,false,'IMPLEMENTED'),
('PERSONAL_DATA_ANONYMIZE','PRIVACY','CRITICAL','SECURITY',
 'Dati personali della prenotazione anonimizzati',true,false,'IMPLEMENTED'),
('PERSONAL_DATA_HOLD','PRIVACY','ELEVATED','SECURITY',
 'Conservazione dei dati personali protetta',true,false,'IMPLEMENTED'),
('PERSONAL_DATA_RELEASE_HOLD','PRIVACY','CRITICAL','SECURITY',
 'Protezione della conservazione rimossa',true,true,'IMPLEMENTED')
ON CONFLICT(action) DO UPDATE SET category=excluded.category,
 severity=excluded.severity,retention_class=excluded.retention_class,
 label_it=excluded.label_it,
 implementation_status=CASE WHEN private.audit_event_catalog.implementation_status='OBSERVED'
   THEN 'OBSERVED' ELSE 'IMPLEMENTED' END;

-- Promote tracked implementations to OBSERVED only after an actual audit INSERT.
-- Limit trigger firing to these explicitly classified privacy actions.
CREATE OR REPLACE FUNCTION private.mark_privacy_event_observed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $body$
BEGIN
 UPDATE private.audit_event_catalog SET implementation_status='OBSERVED'
 WHERE action=NEW.action AND implementation_status='IMPLEMENTED';
 RETURN NULL;
END $body$;
REVOKE ALL ON FUNCTION private.mark_privacy_event_observed() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER audit_privacy_event_observed
AFTER INSERT ON public.audit_log
FOR EACH ROW
WHEN (NEW.action IN (
'SENSITIVE_DATA_ACCESS','PERSONAL_DATA_EXPORTED','PERSONAL_DATA_RECTIFY',
'PERSONAL_DATA_ANONYMIZE','PERSONAL_DATA_HOLD','PERSONAL_DATA_RELEASE_HOLD'
))
EXECUTE FUNCTION private.mark_privacy_event_observed();
