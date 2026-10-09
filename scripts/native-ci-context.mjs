import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createHmac } from 'node:crypto';

export const nativeAssert = (condition, code) => {
  if (!condition) throw new Error(code);
};

// An opt-in flag alone is insufficient: every native probe rechecks Docker's
// actual network, exposed ports and the host's egress rule before any mutation.
export function nativeDatabaseEnvironment(input = process.env) {
  let conn;
  try {
    conn = new URL(input.SUPABASE_DB_URL || 'invalid:');
  } catch {
    throw new Error('NATIVE_CI_REQUIRES_DISPOSABLE_LOOPBACK_STACK');
  }
  nativeAssert(
    input.PLATEFORM_NATIVE_CI === '1' &&
      input.PLATEFORM_INSTALL_LOCAL === '1' &&
      input.PLATEFORM_NATIVE_EGRESS_BLOCKED === '1' &&
      ['postgres:', 'postgresql:'].includes(conn.protocol) &&
      conn.hostname === '127.0.0.1' &&
      conn.port === '54322' &&
      conn.username === 'postgres' &&
      conn.pathname === '/postgres' &&
      !conn.search &&
      !conn.hash,
    'NATIVE_CI_REQUIRES_DISPOSABLE_LOOPBACK_STACK',
  );
  const env = { ...input };
  for (const key of ['SUPABASE_DB_URL', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGHOSTADDR'])
    delete env[key];
  Object.assign(env, {
    PGHOST: conn.hostname,
    PGPORT: conn.port,
    PGUSER: conn.username,
    PGPASSWORD: decodeURIComponent(conn.password),
    PGDATABASE: 'postgres',
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '15',
  });
  return env;
}

export function nativeAPIURL(status) {
  let api;
  try {
    api = new URL(status.API_URL);
  } catch {
    throw new Error('NATIVE_CI_API_REQUIRES_DISPOSABLE_LOOPBACK_STACK');
  }
  nativeAssert(
    api.protocol === 'http:' &&
      api.hostname === '127.0.0.1' &&
      api.port === '54321' &&
      api.pathname === '/' &&
      !api.username &&
      !api.password &&
      !api.search &&
      !api.hash &&
      typeof status.ANON_KEY === 'string' &&
      !!status.ANON_KEY &&
      typeof status.SERVICE_ROLE_KEY === 'string' &&
      !!status.SERVICE_ROLE_KEY,
    'NATIVE_CI_API_REQUIRES_DISPOSABLE_LOOPBACK_STACK',
  );
  return api;
}

export function nativeFetch(api, transport = fetch) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    nativeAssert(
      url.origin === api.origin && !url.username && !url.password,
      'NATIVE_CI_HTTP_TARGET_FORBIDDEN',
    );
    const signal = init.signal || input.signal;
    return transport(input, {
      ...init,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
  };
}

// RFC 6238, SHA-1 / 30-second period / six digits, as used by GoTrue TOTP.
// The secret stays in process memory and never enters SQL, reports or logs.
export function nativeTOTP(secret, timestamp = Date.now()) {
  nativeAssert(/^[A-Z2-7]+={0,6}$/.test(secret), 'NATIVE_CI_INVALID_TOTP_SECRET');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replaceAll('=', ''))
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30000)));
  const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

export async function nativeCIContext() {
  const env = nativeDatabaseEnvironment();
  const run = promisify(execFile);
  const networkName = 'plateform-clean-install-ci';
  const bridge = 'pf_native_ci';
  const network = JSON.parse((await run('docker', ['network', 'inspect', networkName])).stdout)[0];
  nativeAssert(
    network.EnableIPv6 === false &&
      network.Options['com.docker.network.bridge.name'] === bridge &&
      network.Options['com.docker.network.bridge.host_binding_ipv4'] === '127.0.0.1' &&
      Object.keys(network.Containers).length >= 5,
    'NATIVE_CI_NETWORK_ISOLATION_INCOMPLETE',
  );
  await run('sudo', [
    'iptables',
    '-C',
    'DOCKER-USER',
    '-i',
    bridge,
    '!',
    '-o',
    bridge,
    '-j',
    'DROP',
  ]);
  for (const id of Object.keys(network.Containers)) {
    const settings = JSON.parse(
      (await run('docker', ['inspect', '--format', '{{json .NetworkSettings}}', id])).stdout,
    );
    nativeAssert(
      JSON.stringify(Object.keys(settings.Networks)) === JSON.stringify([networkName]),
      'NATIVE_CI_UNRESTRICTED_EXTRA_CONTAINER_NETWORK',
    );
    nativeAssert(
      !Object.values(settings.Ports)
        .flatMap((bindings) => bindings || [])
        .some((binding) => binding.HostIp !== '127.0.0.1' && binding.HostIp !== '::1'),
      'NATIVE_CI_PUBLIC_CONTAINER_PORT',
    );
  }
  const psql = async (sql) => {
    try {
      return (
        await run(
          process.env.PSQL_BIN || 'psql',
          [
            '-X',
            '-w',
            '-q',
            '-A',
            '-t',
            '--set',
            'ON_ERROR_STOP=1',
            '--set',
            'VERBOSITY=sqlstate',
            '--command',
            sql,
          ],
          { env, maxBuffer: 8 * 1024 * 1024 },
        )
      ).stdout.trim();
    } catch (error) {
      const code = String(error.stderr || '').match(/ERROR:\s+([A-Z0-9]{5})\b/)?.[1];
      // execFile causes contain raw SQL/output. Never log them.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`NATIVE_CI_PSQL_FAILED:${code || 'PSQL_ERROR'}`);
    }
  };
  const json = async (sql) => JSON.parse(await psql(sql));
  const platform = await json(`select json_build_object(
    'server_version',current_setting('server_version'),
    'server_version_num',current_setting('server_version_num')::int,
    'auth_users',to_regclass('auth.users') is not null,
    'storage_objects',to_regclass('storage.objects') is not null)`);
  nativeAssert(
    platform.server_version_num >= 170000 &&
      platform.server_version_num < 180000 &&
      platform.auth_users &&
      platform.storage_objects,
    'NATIVE_CI_PLATFORM_INCOMPLETE',
  );
  const status = JSON.parse(await readFile(process.env.PLATEFORM_LOCAL_STATUS_FILE, 'utf8'));
  const api = nativeAPIURL(status);
  return { env, run, network, psql, json, platform, status, api, request: nativeFetch(api) };
}
