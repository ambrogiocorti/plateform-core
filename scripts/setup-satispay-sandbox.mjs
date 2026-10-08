import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const STAGING_BASE = 'https://staging.authservices.satispay.com';
const AUTH_PATH = '/g_business/v1/authentication_keys';
const DEFAULT_OUTPUT = '.local/satispay-sandbox';
const VENUE_ID = '8241033e-7053-44d3-9427-fbf7ea72e684';
const PUBLIC_BASE_URL = 'https://abdxvlykasqmknexxhjo.supabase.co/functions/v1/payment-return';

function parseArgs(argv) {
  const result = { dryRun: false, outputDir: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--output-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --output-dir');
      result.outputDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('SATISPAY_ACTIVATION_CODE is missing and interactive input is unavailable.');
  }
  return new Promise((resolveSecret, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const previousRaw = stdin.isRaw;
    let value = '';

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(previousRaw ?? false);
      stdin.pause();
      stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Interrupted'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolveSecret(value.trim());
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (/^[A-Za-z0-9]$/.test(char)) {
          value += char;
          stdout.write('*');
        }
      }
    };

    stdin.on('data', onData);
  });
}

function assertPem(privateKey, publicKey) {
  if (
    !privateKey.includes('-----BEGIN PRIVATE KEY-----') ||
    !privateKey.includes('-----END PRIVATE KEY-----')
  ) {
    throw new Error('Generated private key is not PKCS#8 PEM');
  }
  if (
    !publicKey.includes('-----BEGIN PUBLIC KEY-----') ||
    !publicKey.includes('-----END PUBLIC KEY-----')
  ) {
    throw new Error('Generated public key is not SPKI PEM');
  }
}

function signedHeaders(method, url, body, keyId, privateKey, date = new Date().toUTCString()) {
  const digest = `SHA-256=${createHash('sha256').update(body).digest('base64')}`;
  const message = `(request-target): ${method.toLowerCase()} ${url.pathname}${url.search}
host: ${url.host}
date: ${date}
digest: ${digest}`;
  const signer = createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  const signature = signer.sign(privateKey, 'base64');
  return {
    'Content-Type': 'application/json',
    Host: url.host,
    Date: date,
    Digest: digest,
    Authorization: `Signature keyId="${keyId}", algorithm="rsa-sha256", headers="(request-target) host date digest", signature="${signature}"`,
    'x-satispay-deviceinfo': 'Plateform sandbox setup',
    'x-satispay-devicetype': 'PC',
    'x-satispay-appn': 'Plateform',
    'x-satispay-appv': '0.1.0',
  };
}

async function testAuthentication(keyId, privateKey) {
  const url = new URL('/wally-services/protocol/tests/signature', STAGING_BASE);
  const body = '{}';
  const response = await fetch(url, {
    method: 'POST',
    headers: signedHeaders('POST', url, body, keyId, privateKey),
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok)
    throw new Error(`Satispay authentication test failed with HTTP ${response.status}`);
  const role = payload?.authentication_key?.role ?? payload?.role;
  if (!['ONLINE_SHOP', 'DEVICE'].includes(role)) {
    throw new Error(
      `Satispay authentication test returned unexpected role: ${String(role ?? 'missing')}`,
    );
  }
  return role;
}

async function registerKey(publicKey, activationCode) {
  const response = await fetch(`${STAGING_BASE}${AUTH_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-satispay-deviceinfo': 'Plateform sandbox setup',
      'x-satispay-devicetype': 'PC',
      'x-satispay-appn': 'Plateform',
      'x-satispay-appv': '0.1.0',
    },
    body: JSON.stringify({ public_key: publicKey, token: activationCode }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(`Satispay registration failed with HTTP ${response.status}`);
  }
  const keyId = payload?.key_id;
  if (typeof keyId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(keyId)) {
    throw new Error('Satispay returned an invalid KeyId');
  }
  return keyId;
}

async function main() {
  const { dryRun, outputDir } = parseArgs(process.argv.slice(2));
  const output = resolve(outputDir);
  await mkdir(output, { recursive: true, mode: 0o700 });

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  assertPem(privateKey, publicKey);

  const privatePath = resolve(output, 'private.pem');
  const publicPath = resolve(output, 'public.pem');
  await writeFile(privatePath, privateKey, { mode: 0o600 });
  await writeFile(publicPath, publicKey, { mode: 0o644 });

  const callbackToken = randomBytes(32).toString('base64url');
  let keyId = null;
  let authenticationRole = null;
  if (!dryRun) {
    const activationCode =
      process.env.SATISPAY_ACTIVATION_CODE?.trim() ||
      (await readSecret('Satispay sandbox activation code: '));
    if (!/^[A-Za-z0-9]+$/.test(activationCode)) {
      throw new Error('Invalid activation code format');
    }
    keyId = await registerKey(publicKey, activationCode);
    authenticationRole = await testAuthentication(keyId, privateKey);
  }

  const credentialsPath = resolve(output, 'credentials.json');
  await writeFile(
    credentialsPath,
    `${JSON.stringify(
      {
        environment: 'sandbox',
        api_base_url: STAGING_BASE,
        key_id: keyId,
        callback_token: callbackToken,
        private_key_path: privatePath,
        public_key_path: publicPath,
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  console.log(
    JSON.stringify(
      {
        result: dryRun ? 'DRY_RUN_PASSED' : 'SATISPAY_SANDBOX_KEY_REGISTERED',
        key_id: keyId,
        authentication_role: authenticationRole,
        private_key_path: privatePath,
        public_key_path: publicPath,
        credentials_path: credentialsPath,
        supabase_secrets: {
          PAYMENTS_MODE: 'test',
          PAYMENTS_VENUE_ID: VENUE_ID,
          PUBLIC_BASE_URL,
          SATISPAY_API_BASE_URL: STAGING_BASE,
          SATISPAY_KEY_ID: keyId ?? '<generated after activation>',
          SATISPAY_PRIVATE_KEY_PKCS8: `<contents of ${privatePath}>`,
          SATISPAY_CALLBACK_TOKEN: '<value stored in credentials.json>',
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
