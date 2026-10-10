import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStagingProjectBinding } from './verify-staging-project-binding.mjs';

const projectRef = 'kghactswtabakkkbojmo';
const base = {
  stagingOrigin: 'https://staging.plateform.example',
  supabaseUrl: `https://${projectRef}.supabase.co`,
  projectRef,
  databaseUrl: `postgresql://postgres.${projectRef}:not-a-real-password@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
  publishableKey: 'sb_publishable_example_not_a_real_token',
};
function expectBlocked(patch, reason) {
  assert.throws(
    () => verifyStagingProjectBinding({ ...base, ...patch }),
    (error) => error.message === reason,
  );
}
function legacyKey(role) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role })).toString('base64url'),
    'test-signature',
  ].join('.');
}

test('accepts exactly bound HTTPS stage API and session pooler', () => {
  const result = verifyStagingProjectBinding(base);
  assert.equal(result.status, 'PASS');
  assert.equal(result.project_ref, projectRef);
  assert.equal(result.database_connection, 'pooler');
});

test('accepts only matching Supabase direct connection', () => {
  const result = verifyStagingProjectBinding({
    ...base,
    databaseUrl: `postgresql://postgres:example-password@db.${projectRef}.supabase.co:5432/postgres`,
  });
  assert.equal(result.database_connection, 'direct');
});

test('rejects missing, Development and populated replica project refs', () => {
  expectBlocked({ projectRef: undefined }, 'STAGING_PROJECT_REF_REQUIRED');
  expectBlocked({ projectRef: 'abdxvlykasqmknexxhjo' }, 'STAGING_RESERVED_PROJECT_REF');
  expectBlocked({ projectRef: 'dkbjgvovxgglqhqxmuyb' }, 'STAGING_RESERVED_PROJECT_REF');
});

test('rejects frontend HTTP, embedded paths and a Supabase URL as origin', () => {
  expectBlocked(
    { stagingOrigin: 'http://staging.plateform.example' },
    'STAGING_ORIGIN_MUST_BE_CLEAN_HTTPS',
  );
  expectBlocked(
    { stagingOrigin: 'https://staging.plateform.example/staff' },
    'STAGING_ORIGIN_MUST_BE_CLEAN_HTTPS',
  );
  expectBlocked(
    { stagingOrigin: `https://${projectRef}.supabase.co` },
    'STAGING_ORIGIN_MUST_BE_CLEAN_HTTPS',
  );
});

test('rejects IP-address and internal .local staging origins', () => {
  expectBlocked(
    { stagingOrigin: 'https://127.0.0.1' },
    'STAGING_ORIGIN_MUST_BE_CLEAN_HTTPS',
  );
  expectBlocked(
    { stagingOrigin: 'https://staging.internal.local' },
    'STAGING_ORIGIN_MUST_BE_CLEAN_HTTPS',
  );
});

test('rejects backend pointing to Development or a mismatched project', () => {
  expectBlocked(
    { supabaseUrl: 'https://abdxvlykasqmknexxhjo.supabase.co' },
    'STAGING_API_PROJECT_REF_MISMATCH',
  );
  expectBlocked(
    { supabaseUrl: `https://${projectRef}.supabase.co/rest/v1` },
    'STAGING_API_PROJECT_REF_MISMATCH',
  );
});

test('rejects pooler tenant cross-binding and non-Supabase hosts', () => {
  expectBlocked(
    {
      databaseUrl:
        'postgresql://postgres.abdxvlykasqmknexxhjo:password@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    },
    'STAGING_DB_PROJECT_REF_MISMATCH',
  );
  expectBlocked(
    {
      databaseUrl: `postgresql://postgres.${projectRef}:password@attacker.example:5432/postgres`,
    },
    'STAGING_DB_PROJECT_REF_MISMATCH',
  );
});

test('rejects direct database binding to a different project', () => {
  expectBlocked(
    {
      databaseUrl:
        'postgresql://postgres:password@db.abdxvlykasqmknexxhjo.supabase.co:5432/postgres',
    },
    'STAGING_DB_PROJECT_REF_MISMATCH',
  );
});

test('rejects missing database password and wrong database name', () => {
  expectBlocked(
    {
      databaseUrl: `postgresql://postgres.${projectRef}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
    },
    'STAGING_DB_CONNECTION_INVALID',
  );
  expectBlocked(
    {
      databaseUrl: `postgresql://postgres.${projectRef}:password@aws-0-eu-west-1.pooler.supabase.com:5432/template1`,
    },
    'STAGING_DB_PROJECT_REF_MISMATCH',
  );
});

test('rejects server-side secret/public-role confusion', () => {
  expectBlocked(
    { publishableKey: 'sb_secret_example_never_in_vite' },
    'STAGING_SECRET_KEY_IN_PUBLIC_ENV',
  );
  expectBlocked({ publishableKey: legacyKey('service_role') }, 'STAGING_NON_ANON_JWT_EXPOSED');
  expectBlocked({ publishableKey: 'abc123.not-a-legit-key' }, 'STAGING_UNRECOGNIZED_PUBLIC_KEY');
});

test('accepts a legacy anon JWT when explicitly configured', () => {
  assert.equal(
    verifyStagingProjectBinding({ ...base, publishableKey: legacyKey('anon') }).status,
    'PASS',
  );
});
