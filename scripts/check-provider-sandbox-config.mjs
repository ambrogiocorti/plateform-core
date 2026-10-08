const provider = (process.argv[2] ?? 'all').toLowerCase();
if (!['stripe', 'satispay', 'all'].includes(provider)) {
  console.error('Usage: node scripts/check-provider-sandbox-config.mjs [stripe|satispay|all]');
  process.exit(2);
}

const failures = [];
const checks = [];
const env = (name) => process.env[name]?.trim() ?? '';
const pass = (name) => checks.push({ name, status: 'PASSED' });
const fail = (name, reason) => {
  checks.push({ name, status: 'FAILED', reason });
  failures.push(`${name}: ${reason}`);
};

function requireValue(name, predicate, reason) {
  const value = env(name);
  if (!value) return fail(name, 'missing');
  if (predicate && !predicate(value)) return fail(name, reason);
  pass(name);
  return value;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const mode = requireValue(
  'PAYMENTS_MODE',
  (v) => v === 'test',
  'must be exactly "test" for the sandbox gate',
);
requireValue('PAYMENTS_VENUE_ID', (v) => uuid.test(v), 'must be a UUID');

const publicBase = requireValue('PUBLIC_BASE_URL');
if (publicBase) {
  try {
    const url = new URL(publicBase);
    const placeholder =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname.endsWith('.example') ||
      url.hostname.endsWith('.invalid') ||
      url.hostname.endsWith('.test');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      placeholder
    ) {
      fail(
        'PUBLIC_BASE_URL_POLICY',
        'must be a real public HTTPS origin without credentials, query, hash, localhost, or reserved test/example domains',
      );
    } else {
      pass('PUBLIC_BASE_URL_POLICY');
    }
  } catch {
    fail('PUBLIC_BASE_URL_POLICY', 'must be a valid URL');
  }
}

if (provider === 'stripe' || provider === 'all') {
  requireValue(
    'STRIPE_SECRET_KEY',
    (v) => v.startsWith('sk_test_'),
    'must be a Stripe sandbox secret key (sk_test_)',
  );
  requireValue(
    'STRIPE_WEBHOOK_SECRET',
    (v) => v.startsWith('whsec_') && v.length >= 16,
    'must be a Stripe webhook signing secret',
  );
}

if (provider === 'satispay' || provider === 'all') {
  requireValue(
    'SATISPAY_API_BASE_URL',
    (v) => v === 'https://staging.authservices.satispay.com',
    'must be the Satispay staging API base URL',
  );
  requireValue(
    'SATISPAY_KEY_ID',
    (v) => /^[A-Za-z0-9_-]+$/.test(v),
    'contains unsupported characters',
  );
  requireValue(
    'SATISPAY_PRIVATE_KEY_PKCS8',
    (v) => v.includes('-----BEGIN PRIVATE KEY-----') && v.includes('-----END PRIVATE KEY-----'),
    'must be a PKCS#8 private key PEM',
  );
  requireValue('SATISPAY_CALLBACK_TOKEN', (v) => v.length >= 32, 'must be at least 32 characters');
}

const output = {
  provider,
  sandbox_mode: mode === 'test',
  checks,
  passed: failures.length === 0,
};
console.log(JSON.stringify(output, null, 2));
if (failures.length) process.exit(1);
