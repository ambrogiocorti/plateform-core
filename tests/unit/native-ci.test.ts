import { describe, expect, it, vi } from 'vitest';
import {
  nativeAPIURL,
  nativeDatabaseEnvironment,
  nativeFetch,
  nativeTOTP,
} from '../../scripts/native-ci-context.mjs';
import {
  nativeFixtureIDs,
  nativeFixtureSQL,
  nativeActors,
} from '../../scripts/native-ci-fixtures.mjs';

const config = {
  SUPABASE_DB_URL: 'postgresql://postgres:fixture-secret@127.0.0.1:54322/postgres',
  PLATEFORM_NATIVE_CI: '1',
  PLATEFORM_INSTALL_LOCAL: '1',
  PLATEFORM_NATIVE_EGRESS_BLOCKED: '1',
};
const status = {
  API_URL: 'http://127.0.0.1:54321',
  ANON_KEY: 'local-anon',
  SERVICE_ROLE_KEY: 'local-server',
};

describe('disposable native CI boundary', () => {
  it('requires all opt-ins and the exact loopback database before external commands', () => {
    expect(nativeDatabaseEnvironment(config).PGHOST).toBe('127.0.0.1');
    for (const key of [
      'PLATEFORM_NATIVE_CI',
      'PLATEFORM_INSTALL_LOCAL',
      'PLATEFORM_NATIVE_EGRESS_BLOCKED',
    ])
      expect(() => nativeDatabaseEnvironment({ ...config, [key]: undefined })).toThrow(
        'NATIVE_CI_REQUIRES_DISPOSABLE_LOOPBACK_STACK',
      );
    for (const url of [
      'postgresql://postgres:secret@db.hosted.supabase.co:54322/postgres',
      'postgresql://postgres:secret@localhost:54322/postgres',
      'postgresql://postgres:secret@127.0.0.1:5432/postgres',
      'postgresql://postgres:secret@127.0.0.1:54322/customer',
      'postgresql://service_role:secret@127.0.0.1:54322/postgres',
      config.SUPABASE_DB_URL + '?host=db.hosted.supabase.co',
      'not a valid URL with secret',
    ])
      expect(() => nativeDatabaseEnvironment({ ...config, SUPABASE_DB_URL: url })).toThrow(
        'NATIVE_CI_REQUIRES_DISPOSABLE_LOOPBACK_STACK',
      );
  });

  it('removes connection overrides without disclosing or passing secrets as arguments', () => {
    const env = nativeDatabaseEnvironment({
      ...config,
      PGSERVICE: 'customer',
      PGSERVICEFILE: '/customer',
      PGPASSFILE: '/customer-passwords',
      PGHOSTADDR: '203.0.113.10',
      PGHOST: 'customer',
      PGUSER: 'customer',
    });
    expect(env).toMatchObject({
      PGHOST: '127.0.0.1',
      PGPORT: '54322',
      PGDATABASE: 'postgres',
      PGUSER: 'postgres',
      PGPASSWORD: 'fixture-secret',
      PGSSLMODE: 'disable',
    });
    for (const key of ['SUPABASE_DB_URL', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGHOSTADDR'])
      expect(env).not.toHaveProperty(key);
  });

  it('refuses API credentials, non-loopback URLs, alternate ports and URL suffixes', () => {
    expect(nativeAPIURL(status).origin).toBe('http://127.0.0.1:54321');
    for (const url of [
      'https://hosted.supabase.co',
      'http://localhost:54321',
      'http://127.0.0.1:80',
      'http://user:secret@127.0.0.1:54321',
      'http://127.0.0.1:54321/customer',
      'http://127.0.0.1:54321/?redirect=hosted',
      'http://127.0.0.1:54321/#hosted',
    ])
      expect(() => nativeAPIURL({ ...status, API_URL: url })).toThrow(
        'NATIVE_CI_API_REQUIRES_DISPOSABLE_LOOPBACK_STACK',
      );
    expect(() => nativeAPIURL({ ...status, SERVICE_ROLE_KEY: '' })).toThrow(
      'NATIVE_CI_API_REQUIRES_DISPOSABLE_LOOPBACK_STACK',
    );
  });

  it('rejects an SDK request outside the local API without invoking the transport', async () => {
    const transport = vi.fn<typeof fetch>();
    const request = nativeFetch(nativeAPIURL(status), transport);
    for (const url of [
      'https://hosted.supabase.co/auth/v1/token',
      'http://127.0.0.1:54322/',
      'http://user:secret@127.0.0.1:54321/auth/v1/user',
    ])
      await expect(request(url)).rejects.toThrow('NATIVE_CI_HTTP_TARGET_FORBIDDEN');
    expect(transport).not.toHaveBeenCalled();
  });

  it('overrides redirect-following and applies a timeout to each accepted request', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const request = nativeFetch(nativeAPIURL(status), transport);
    await request('http://127.0.0.1:54321/auth/v1/user', { redirect: 'follow' });
    expect(transport).toHaveBeenCalledWith(
      'http://127.0.0.1:54321/auth/v1/user',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
  });

  it('matches the RFC 6238 SHA-1 vectors with six-digit output', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    for (const [seconds, code] of [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ] as const)
      expect(nativeTOTP(secret, seconds * 1000)).toBe(code);
    expect(() => nativeTOTP('invalid-secret')).toThrow('NATIVE_CI_INVALID_TOTP_SECRET');
  });

  it('refuses fixture SQL interpolation of an invalid or missing identity', () => {
    const ids = nativeFixtureIDs();
    const users = Object.fromEntries(
      nativeActors.map((actor) => [actor.name, crypto.randomUUID()]),
    );
    expect(() =>
      nativeFixtureSQL(ids, { ...users, adminA: "' ; delete from auth.users; --" }),
    ).toThrow('NATIVE_CI_INVALID_FIXTURE_ID');
    expect(() => nativeFixtureSQL(ids, {})).toThrow('NATIVE_CI_INVALID_FIXTURE_ID');
    expect(() =>
      nativeFixtureSQL({ ...ids, venueA: "' ; delete from public.venues; --" }, users),
    ).toThrow('NATIVE_CI_INVALID_FIXTURE_ID');
  });
});
