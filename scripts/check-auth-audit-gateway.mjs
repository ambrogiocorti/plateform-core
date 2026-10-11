import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const gateway = readFileSync('supabase/functions/auth-audit-gateway/index.ts','utf8');
const staff = readFileSync('src/auth/staff.ts','utf8');
const permission = readFileSync(
  'supabase/migrations/20261011155756_audit_auth_gateway_rejected_login_mfa_service_only.sql',
  'utf8',
);

assert.match(staff, /functions\.invoke\('auth-audit-gateway'/);
assert.doesNotMatch(staff, /auth\.signInWithPassword\(/);
assert.doesNotMatch(staff, /auth\.mfa\.challengeAndVerify\(/);
assert.match(gateway, /verifier\.auth\.signInWithPassword\(/);
assert.match(gateway, /error\.code !== 'invalid_credentials'/);
assert.match(gateway, /providerCode !== 'mfa_verification_failed'/);
assert.match(gateway, /rateLimit\('auth-password-gateway:/);
assert.match(gateway, /rateLimit\('auth-mfa-gateway:/);
assert.match(gateway, /await caller\.auth\.getUser\(\)/);
assert.match(gateway, /listFactors\(\)/);
assert.match(gateway, /reportVerifiedDenial\(request, 'MFA_VERIFICATION_FAILED'/);
assert.doesNotMatch(gateway, /console\.(log|error)\(.*(?:body\.password|body\.code)/);
assert.match(permission, /REVOKE ALL ON FUNCTION public\.record_auth_gateway_failure/);
assert.match(permission, /GRANT EXECUTE ON FUNCTION public\.record_auth_gateway_failure/);
assert.match(permission, /TO service_role/);
console.log('PASS: staff auth and MFA only emit provider-confirmed denied audit events');
