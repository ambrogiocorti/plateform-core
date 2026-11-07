-- Plateform Security & Business Audit hardening.
-- Never rewrite or purge old audit events.
CREATE TABLE IF NOT EXISTS private.audit_event_catalog (
 action text PRIMARY KEY CHECK (action ~ '^[A-Z][A-Z0-9_]*$'),
 category text NOT NULL CHECK (category IN ('SECURITY','STAFF_ADMIN','MENU_INVENTORY','SERVICE_ORDERS','FINANCE','RESERVATIONS','OPERATIONS','PRIVACY','CONTINUITY','SYSTEM','OTHER')),
 severity text NOT NULL CHECK (severity IN ('NORMAL','ELEVATED','CRITICAL')),
 retention_class text NOT NULL CHECK (retention_class IN ('SECURITY','BUSINESS','FINANCIAL','TECHNICAL')),
 label_it text NOT NULL,
 requires_reason boolean NOT NULL DEFAULT false,
 requires_approval boolean NOT NULL DEFAULT false,
 implementation_status text NOT NULL CHECK (implementation_status IN ('OBSERVED','PLANNED')),
 catalogued_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.audit_event_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.audit_event_catalog FROM PUBLIC,anon,authenticated;
CREATE INDEX IF NOT EXISTS audit_event_catalog_category_idx ON private.audit_event_catalog(category,action);

INSERT INTO private.audit_event_catalog
(action,category,severity,retention_class,label_it,requires_reason,requires_approval,implementation_status)
SELECT DISTINCT a.action,
 CASE
 WHEN a.action ~ '(DATA_EXPORT|DATA_ERASED|PERSONAL_DATA|PRIVACY|RETENTION_ANONYMIZED)' THEN 'PRIVACY'
 WHEN a.action ~ '^(AUTH_|PIN_|SESSION_|STEP_UP_|IMPERSONATION_|STAFF_PASSWORD|PASSWORD_|DEVICE_REVOKED)' OR a.action ~ '(ACCESS_CHANGED|REACTIVATION_AUTHORIZED|STAFF_DISABLED|SECURITY_GATE|RLS_GATE)' THEN 'SECURITY'
 WHEN a.action ~ '(PAYMENT|REFUND|CASH|DISCOUNT|ACCOUNT|PROVIDER_RESULT|PROVIDER_COMMAND|EQUAL_SPLIT)' THEN 'FINANCE'
 WHEN a.action ~ '(BACKUP|RESTORE|RELEASE|MIGRATION|STEP13|INCIDENT)' THEN 'CONTINUITY'
 WHEN a.action ~ '(STAFF_|REGISTERED_DEVICES|CASHIER_ASSIGNMENT)' THEN 'STAFF_ADMIN'
 WHEN a.action ~ '(RESERVATION|BOOKING|NO_SHOW)' THEN 'RESERVATIONS'
 WHEN a.action ~ '(DISH|INGREDIENT|CATEGORY|CATEGORIES|MENU|ALLERGEN|DIETARY)' THEN 'MENU_INVENTORY'
 WHEN a.action ~ '(ORDER|TABLE|ROOM|SERVICE|STATION|RETURNED_ITEM)' THEN 'SERVICE_ORDERS'
 WHEN a.action ~ '(SYNC|OFFLINE|NOTIFICATION|PRINT)' THEN 'OPERATIONS'
 WHEN a.action ~ '(FEATURE_FLAG|SYSTEM_LIMIT|VENUE_SETTING|RESTAURANT_SETTINGS)' THEN 'SYSTEM'
 ELSE 'OTHER' END,
 CASE
 WHEN a.action ~ '(IMPERSONATION|STAFF_PASSWORD|PASSWORD_|PIN_FAILED|DEVICE_REVOKED|PAYMENT|REFUND|CASH_|BACKUP_FAILED|RESTORE_|SECURITY_GATE|RLS_GATE)' THEN 'CRITICAL'
 WHEN a.action ~ '(ORDER|DISCOUNT|STAFF_|AUTH_|PIN_|ROLE|PERMISSION|PRICE|INGREDIENT|BACKUP)' THEN 'ELEVATED'
 ELSE 'NORMAL' END,
 CASE
 WHEN a.action ~ '(AUTH_|PIN_|SESSION_|STEP_UP_|IMPERSONATION|STAFF_PASSWORD|PASSWORD_|SECURITY_GATE|RLS_GATE|DEVICE_REVOKED)' THEN 'SECURITY'
 WHEN a.action ~ '(PAYMENT|REFUND|CASH|DISCOUNT|ACCOUNT|PROVIDER_RESULT|PROVIDER_COMMAND|EQUAL_SPLIT)' THEN 'FINANCIAL'
 WHEN a.action ~ '(BACKUP|RESTORE|RELEASE|MIGRATION|STEP13|HEALTH_CHECK)' THEN 'TECHNICAL'
 ELSE 'BUSINESS' END,
 replace(initcap(replace(lower(a.action),'_',' ')),' Id ',' ID '),
 a.action ~ '(REFUND|REVERSAL|CANCEL|REOPEN|DISCOUNT|IMPERSONATION_WRITE_ENABLED|STAFF_DISABLED|DATA_EXPORT)',
 a.action ~ '(REFUND|REVERSAL|IMPERSONATION_WRITE_ENABLED|STAFF_PASSWORD_RESET_AUTHORIZED)',
 'OBSERVED'
FROM public.audit_log a ON CONFLICT(action) DO NOTHING;

-- Planned types are catalogued, but not claimed to be emitted.
INSERT INTO private.audit_event_catalog
(action,category,severity,retention_class,label_it,requires_reason,requires_approval,implementation_status)
VALUES
('AUTH_LOGIN_FAILED','SECURITY','CRITICAL','SECURITY','Accesso non riuscito',false,false,'PLANNED'),
('MFA_VERIFICATION_FAILED','SECURITY','CRITICAL','SECURITY','Verifica MFA non riuscita',false,false,'PLANNED'),
('SENSITIVE_DATA_ACCESS','PRIVACY','ELEVATED','SECURITY','Consultazione di dati personali sensibili',true,false,'PLANNED'),
('SENSITIVE_DATA_EXPORTED','PRIVACY','CRITICAL','SECURITY','Esportazione di dati personali',true,true,'PLANNED'),
('AUDIT_EXPORTED','SECURITY','CRITICAL','SECURITY','Esportazione del registro audit',true,true,'PLANNED'),
('ACCESS_DENIED','SECURITY','ELEVATED','SECURITY','Accesso negato a una risorsa',false,false,'PLANNED'),
('PRIVILEGE_CHANGE_DENIED','SECURITY','CRITICAL','SECURITY','Modifica privilegi negata',false,false,'PLANNED')
ON CONFLICT(action) DO NOTHING;

-- IP/User-Agent collection deliberately disabled until trusted ingress and privacy retention exist.
ALTER TABLE public.audit_log
 ADD COLUMN IF NOT EXISTS ip_address inet,
 ADD COLUMN IF NOT EXISTS user_agent text,
 ADD COLUMN IF NOT EXISTS emitter_source text NOT NULL DEFAULT 'DATABASE_AUDIT',
 ADD COLUMN IF NOT EXISTS reason_code text,
 ADD COLUMN IF NOT EXISTS authorization_context jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Device heartbeat/last-sync/app-version updates remain in telemetry, not audit.
-- Security and configuration changes stay audited.
DROP TRIGGER IF EXISTS audit_mutation ON public.registered_devices;
CREATE TRIGGER audit_registered_device_insert_delete
AFTER INSERT OR DELETE ON public.registered_devices
FOR EACH ROW EXECUTE FUNCTION private.audit_row();
CREATE TRIGGER audit_registered_device_important_update
AFTER UPDATE ON public.registered_devices FOR EACH ROW
WHEN (
 OLD.user_id IS DISTINCT FROM NEW.user_id OR
 OLD.venue_id IS DISTINCT FROM NEW.venue_id OR
 OLD.display_name IS DISTINCT FROM NEW.display_name OR
 OLD.platform IS DISTINCT FROM NEW.platform OR
 OLD.assigned_role_or_station IS DISTINCT FROM NEW.assigned_role_or_station OR
 OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
)
EXECUTE FUNCTION private.audit_row();

CREATE OR REPLACE FUNCTION public.get_audit_event_catalog()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
 PERFORM private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[],false);
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
 'action',c.action,'category',c.category,'severity',c.severity,
 'label_it',c.label_it,'requires_reason',c.requires_reason,
 'requires_approval',c.requires_approval,'implementation_status',c.implementation_status
 ) ORDER BY c.action) FROM private.audit_event_catalog c),'[]'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION public.get_audit_event_catalog() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_audit_event_catalog() TO authenticated;

CREATE OR REPLACE FUNCTION public.search_audit_professional(
 p_venue uuid DEFAULT NULL, p_actor uuid DEFAULT NULL,
 p_resource uuid DEFAULT NULL,p_request uuid DEFAULT NULL,
 p_action text DEFAULT '',p_result text DEFAULT NULL,
 p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL,
 p_before_at timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,
 p_limit integer DEFAULT 50,p_correlation uuid DEFAULT NULL,
 p_role public.user_role DEFAULT NULL,p_impersonated boolean DEFAULT NULL,
 p_resource_type text DEFAULT NULL,p_category text DEFAULT NULL,p_severity text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
 PERFORM private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[],false);
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR coalesce(length(p_action),0)>100
 OR coalesce(length(p_resource_type),0)>100 OR (p_before_at IS NULL)<>(p_before_id IS NULL)
 OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from>p_to)
 OR (p_category IS NOT NULL AND p_category NOT IN
 ('SECURITY','STAFF_ADMIN','MENU_INVENTORY','SERVICE_ORDERS','FINANCE','RESERVATIONS',
  'OPERATIONS','PRIVACY','CONTINUITY','SYSTEM','OTHER','UNCATALOGUED'))
 OR (p_severity IS NOT NULL AND p_severity NOT IN ('NORMAL','ELEVATED','CRITICAL'))
 THEN RAISE EXCEPTION 'INVALID_FILTER'; END IF;
 RETURN (
 WITH page AS (
 SELECT a.*,coalesce(c.category,'UNCATALOGUED') AS category,
 coalesce(c.severity,'ELEVATED') AS severity,
 coalesce(c.label_it,replace(initcap(replace(lower(a.action),'_',' ')),' Id ',' ID ')) AS action_label,
 coalesce(c.retention_class,'SECURITY') AS retention_class
 FROM public.audit_log a LEFT JOIN private.audit_event_catalog c ON c.action=a.action
 WHERE (p_venue IS NULL OR a.venue_id=p_venue)
 AND (p_actor IS NULL OR a.actor_user_id=p_actor)
 AND (p_resource IS NULL OR a.resource_id=p_resource)
 AND (p_request IS NULL OR a.request_id=p_request)
 AND (p_correlation IS NULL OR a.correlation_id=p_correlation)
 AND (p_role IS NULL OR a.actor_role=p_role)
 AND (p_impersonated IS NULL OR (a.impersonated_by IS NOT NULL)=p_impersonated)
 AND (p_resource_type IS NULL OR a.resource_type=p_resource_type)
 AND (coalesce(p_action,'')='' OR strpos(lower(a.action),lower(p_action))>0)
 AND (p_result IS NULL OR a.result=p_result)
 AND (p_category IS NULL OR coalesce(c.category,'UNCATALOGUED')=p_category)
 AND (p_severity IS NULL OR coalesce(c.severity,'ELEVATED')=p_severity)
 AND (p_from IS NULL OR a.timestamp>=p_from)
 AND (p_to IS NULL OR a.timestamp<=p_to)
 AND (p_before_at IS NULL OR (a.timestamp,a.id)<(p_before_at,p_before_id))
 ORDER BY a.timestamp DESC,a.id DESC LIMIT p_limit+1
 )
 SELECT jsonb_build_object(
 'events',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.timestamp DESC,x.id DESC)
 FROM (SELECT * FROM page ORDER BY timestamp DESC,id DESC LIMIT p_limit) x),'[]'::jsonb),
 'has_more',(SELECT count(*)>p_limit FROM page))
 );
END $fn$;
REVOKE ALL ON FUNCTION public.search_audit_professional(
 uuid,uuid,uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid,
 public.user_role,boolean,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_audit_professional(
 uuid,uuid,uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid,
 public.user_role,boolean,text,text,text) TO authenticated;