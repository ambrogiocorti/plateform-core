import { describe, expect, it } from 'vitest';
import { securityHeaders, validateEnvironment } from '../../shared/deployment';
import { contextualHeaders, requestContext } from '../../shared/request-context';

const configuration = {
  environment: 'production' as const,
  publicBaseUrl: 'https://restaurant.test',
  staffBaseUrl: 'https://restaurant.test/staff',
  supabaseUrl: 'https://backend.supabase.co',
  publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwx',
  releaseVersion: '0.1.0',
};

describe('deployment security boundary', () => {
  it('supports the specified /staff path and the separate-host alternative', () => {
    expect(validateEnvironment(configuration).staffBaseUrl).toBe('https://restaurant.test/staff');
    expect(
      validateEnvironment({ ...configuration, staffBaseUrl: 'https://staff.restaurant.test' })
        .environment,
    ).toBe('production');
  });
  it.each([
    'https://restaurant.test',
    'https://restaurant.test/staffing',
    'https://restaurant.test/login',
  ])('rejects an overlapping staff application: %s', (staffBaseUrl) => {
    expect(() => validateEnvironment({ ...configuration, staffBaseUrl })).toThrow(
      'STAFF_PATH_ISOLATION_REQUIRED',
    );
  });
  it.each([
    'http://restaurant.test',
    'ftp://restaurant.test',
    'https://user:pass@restaurant.test',
    'https://restaurant.test?token=private',
    'https://restaurant.test/#secret',
  ])('rejects insecure application URL: %s', (publicBaseUrl) => {
    expect(() => validateEnvironment({ ...configuration, publicBaseUrl })).toThrow();
  });
  it.each([
    'sb_secret_abcdefghijklmnopqrstuvwx',
    'sk_live_abcdefghijklmnopqrstuvwx',
    'sk_test_abcdefghijklmnopqrstuvwx',
    'invalid-key-of-at-least-twenty-characters',
  ])('rejects a server key or invalid frontend key', (publishableKey) => {
    expect(() => validateEnvironment({ ...configuration, publishableKey })).toThrow();
  });
  it('accepts only anon in a legacy JWT key', () => {
    const key = (role: string) => `header.${btoa(JSON.stringify({ role }))}.signature`;
    expect(
      validateEnvironment({ ...configuration, publishableKey: key('anon') }).publishableKey,
    ).toBe(key('anon'));
    expect(() =>
      validateEnvironment({ ...configuration, publishableKey: key('service_role') }),
    ).toThrow('INVALID_PUBLIC_KEY');
  });
  it('requires explicit origins and excludes wildcard connections and inline scripts', () => {
    const headers = securityHeaders(configuration, 'staff', {
      connectOrigins: ['https://bridge.restaurant.test'],
    });
    expect(headers['Content-Security-Policy']).toContain("script-src 'self';");
    expect(headers['Content-Security-Policy']).toContain('wss://backend.supabase.co');
    expect(headers['Content-Security-Policy']).toContain('https://bridge.restaurant.test');
    expect(headers['Content-Security-Policy']).not.toContain('unsafe-eval');
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(headers['Strict-Transport-Security']).toBe('max-age=31536000');
    expect(securityHeaders(configuration, 'public')['X-Robots-Tag']).toBeUndefined();
    expect(() =>
      securityHeaders(configuration, 'staff', { connectOrigins: ['https://*.restaurant.test'] }),
    ).toThrow();
  });
});

describe('request and correlation identifiers', () => {
  it('preserves distinct identifiers across a multi-request operation', () => {
    const requestId = crypto.randomUUID(),
      correlationId = crypto.randomUUID();
    const headers = contextualHeaders({
      'x-request-id': requestId,
      'x-correlation-id': correlationId,
    });
    expect(requestContext(headers)).toEqual({ requestId, correlationId });
    expect(headers.get('x-correlation-id')).toBe(correlationId);
  });
  it('replaces untrusted identifiers and defaults correlation to the request', () => {
    const context = requestContext(
      new Headers({ 'x-request-id': 'private-password', 'x-correlation-id': 'SQL error' }),
    );
    expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.correlationId).toBe(context.requestId);
  });
});
