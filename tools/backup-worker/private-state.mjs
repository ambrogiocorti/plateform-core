export const DURABLE_PRIVATE_TABLES = [
  'api_permission_manifest',
  'continuity_settings',
  'customer_access_codes',
  'customer_identity_retention',
  'device_registration_secrets',
  'idempotency_keys',
  'provider_events',
  'provider_operation_events',
  'staff_access_change_reasons',
  'staff_command_secret_fingerprints',
  'staff_pins',
];

export const EPHEMERAL_PRIVATE_TABLES = [
  'customer_access_backoff',
  'customer_sessions',
  'device_heartbeats',
  'impersonation_sessions',
  'offline_challenges',
  'public_requests',
  'rate_limits',
  'staff_sessions',
  'step_up_grants',
];

export const EPHEMERAL_AUTH_TABLES = [
  'flow_state',
  'mfa_amr_claims',
  'mfa_challenges',
  'oauth_authorizations',
  'oauth_client_states',
  'one_time_tokens',
  'refresh_tokens',
  'saml_relay_states',
  'sessions',
  'webauthn_challenges',
];

const q = (value) => `"${value.replaceAll('"', '""')}"`;

function rowHashSql(schema, table) {
  return `encode(digest(coalesce((select string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text) from ${q(schema)}.${q(table)} t),''),'sha256'),'hex')`;
}

export function durablePrivateStateSql() {
  const rows = DURABLE_PRIVATE_TABLES.map(
    (table) =>
      `json_build_object('table','${table}','count',(select count(*) from private.${q(table)}),'sha256',${rowHashSql('private', table)})`,
  ).join(',');
  const aggregate = DURABLE_PRIVATE_TABLES.map(
    (table) =>
      `'${table}'||'|'||(select count(*)::text from private.${q(table)})||'|'||${rowHashSql('private', table)}`,
  ).join(',');
  return `json_build_object(
    'table_count',${DURABLE_PRIVATE_TABLES.length},
    'row_count',${DURABLE_PRIVATE_TABLES.map((table) => `(select count(*) from private.${q(table)})`).join('+')},
    'aggregate_sha256',encode(digest(concat_ws(E'\\n',${aggregate}),'sha256'),'hex'),
    'tables',json_build_array(${rows})
  )`;
}

export function securityStateSql() {
  const privateCounts = EPHEMERAL_PRIVATE_TABLES.map(
    (table) =>
      `json_build_object('table','private.${table}','count',(select count(*) from private.${q(table)}))`,
  ).join(',');
  const authCounts = EPHEMERAL_AUTH_TABLES.map(
    (table) =>
      `json_build_object('table','auth.${table}','count',(select count(*) from auth.${q(table)}))`,
  ).join(',');
  return `json_build_object(
    'private',json_build_array(${privateCounts}),
    'auth',json_build_array(${authCounts})
  )`;
}

export function sanitizeSecuritySql() {
  const privateDeletes = EPHEMERAL_PRIVATE_TABLES.map(
    (table) => `delete from private.${q(table)};`,
  ).join('\n');
  const authDeletes = EPHEMERAL_AUTH_TABLES.map((table) => `delete from auth.${q(table)};`).join(
    '\n',
  );
  return `begin;
set local session_replication_role=replica;
${privateDeletes}
${authDeletes}
set local session_replication_role=origin;
commit;`;
}
