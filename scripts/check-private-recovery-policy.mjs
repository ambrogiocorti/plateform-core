import {
  DURABLE_PRIVATE_TABLES,
  EPHEMERAL_PRIVATE_TABLES,
  EPHEMERAL_AUTH_TABLES,
  durablePrivateStateSql,
  sanitizeSecuritySql,
  securityStateSql,
} from '../tools/backup-worker/private-state.mjs';

const overlap = DURABLE_PRIVATE_TABLES.filter((name) => EPHEMERAL_PRIVATE_TABLES.includes(name));
if (overlap.length) throw new Error(`PRIVATE_POLICY_OVERLAP:${overlap.join(',')}`);
for (const required of [
  'staff_pins',
  'continuity_settings',
  'idempotency_keys',
  'provider_events',
  'provider_operation_events',
  'device_registration_secrets',
])
  if (!DURABLE_PRIVATE_TABLES.includes(required))
    throw new Error(`PRIVATE_DURABLE_MISSING:${required}`);
for (const required of [
  'staff_sessions',
  'step_up_grants',
  'rate_limits',
  'impersonation_sessions',
  'customer_sessions',
])
  if (!EPHEMERAL_PRIVATE_TABLES.includes(required))
    throw new Error(`PRIVATE_EPHEMERAL_MISSING:${required}`);
for (const required of [
  'sessions',
  'refresh_tokens',
  'mfa_amr_claims',
  'mfa_challenges',
  'one_time_tokens',
])
  if (!EPHEMERAL_AUTH_TABLES.includes(required))
    throw new Error(`AUTH_EPHEMERAL_MISSING:${required}`);
const sanitize = sanitizeSecuritySql();
for (const table of EPHEMERAL_PRIVATE_TABLES)
  if (!sanitize.includes(`delete from private."${table}";`))
    throw new Error(`PRIVATE_SANITIZE_MISSING:${table}`);
for (const table of EPHEMERAL_AUTH_TABLES)
  if (!sanitize.includes(`delete from auth."${table}";`))
    throw new Error(`AUTH_SANITIZE_MISSING:${table}`);
for (const table of DURABLE_PRIVATE_TABLES)
  if (sanitize.includes(`delete from private."${table}";`))
    throw new Error(`DURABLE_TABLE_DELETED:${table}`);
const durable = durablePrivateStateSql();
for (const table of DURABLE_PRIVATE_TABLES)
  if (!durable.includes(table)) throw new Error(`PRIVATE_FINGERPRINT_MISSING:${table}`);
if (!durable.includes('aggregate_sha256') || !securityStateSql().includes("'auth'"))
  throw new Error('PRIVATE_STATE_SQL_INVALID');
console.log('STEP12_PRIVATE_RECOVERY_POLICY=PASSED');
