import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const RESERVED_PROJECT_REFS = new Set([
  'abdxvlykasqmknexxhjo', // Plateform Development — NEVER a staging target
  'dkbjgvovxgglqhqxmuyb', // Populated continuity replica/restore-test
]);
const PROJECT_REF = /^[a-z0-9]{20}$/;

function blocked(code) {
  throw new Error(code);
}

function parseUrl(raw, code) {
  try {
    return new URL(raw);
  } catch {
    return blocked(code);
  }
}

export function verifyStagingProjectBinding({
  stagingOrigin,
  supabaseUrl,
  projectRef,
  databaseUrl,
  publishableKey,
}) {
  if (!PROJECT_REF.test(projectRef ?? '')) blocked('STAGING_PROJECT_REF_REQUIRED');
  if (RESERVED_PROJECT_REFS.has(projectRef)) blocked('STAGING_RESERVED_PROJECT_REF');

  const origin = parseUrl(stagingOrigin, 'STAGING_ORIGIN_INVALID');
  if (
    origin.protocol !== 'https:' ||
    !origin.hostname.includes('.') ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.hostname.endsWith('.supabase.co') ||
    origin.hostname.endsWith('.local') ||
    isIP(origin.hostname) !== 0
  ) {
    blocked('STAGING_ORIGIN_MUST_BE_CLEAN_HTTPS');
  }

  const backend = parseUrl(supabaseUrl, 'STAGING_API_URL_INVALID');
  if (
    backend.protocol !== 'https:' ||
    backend.hostname !== `${projectRef}.supabase.co` ||
    backend.username ||
    backend.password ||
    backend.port ||
    backend.pathname !== '/' ||
    backend.search ||
    backend.hash
  ) {
    blocked('STAGING_API_PROJECT_REF_MISMATCH');
  }

  const db = parseUrl(databaseUrl, 'STAGING_DB_URL_INVALID');
  if (!['postgresql:', 'postgres:'].includes(db.protocol) || !db.password) {
    blocked('STAGING_DB_CONNECTION_INVALID');
  }
  const dbUser = decodeURIComponent(db.username);
  const directHost = `db.${projectRef}.supabase.co`;
  const direct = db.hostname === directHost && dbUser === 'postgres';
  const pooled =
    /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(db.hostname) && dbUser === `postgres.${projectRef}`;
  if (
    (!direct && !pooled) ||
    db.pathname !== '/postgres' ||
    !['', '5432', '6543'].includes(db.port) ||
    db.search ||
    db.hash
  ) {
    blocked('STAGING_DB_PROJECT_REF_MISMATCH');
  }

  if (typeof publishableKey !== 'string' || publishableKey.length < 20) {
    blocked('STAGING_PUBLISHABLE_KEY_REQUIRED');
  }
  if (publishableKey.startsWith('sb_secret_')) {
    blocked('STAGING_SECRET_KEY_IN_PUBLIC_ENV');
  }
  if (!publishableKey.startsWith('sb_publishable_')) {
    const parts = publishableKey.split('.');
    if (parts.length !== 3) blocked('STAGING_UNRECOGNIZED_PUBLIC_KEY');
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      blocked('STAGING_PUBLIC_KEY_INVALID');
    }
    if (payload?.role !== 'anon') blocked('STAGING_NON_ANON_JWT_EXPOSED');
  }

  return {
    status: 'PASS',
    environment: 'staging',
    project_ref: projectRef,
    frontend_hostname: origin.hostname,
    database_connection: direct ? 'direct' : 'pooler',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = verifyStagingProjectBinding({
      stagingOrigin: process.env.PLATEFORM_STAGING_ORIGIN,
      supabaseUrl: process.env.VITE_SUPABASE_URL,
      projectRef: process.env.STAGING_SUPABASE_PROJECT_REF,
      databaseUrl: process.env.STAGING_SUPABASE_DB_URL,
      publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    });
    console.log(
      `STAGING_PROJECT_BINDING=${report.status} ${report.project_ref} ${report.database_connection}`,
    );
  } catch (error) {
    // Never print source URLs, the connection string or a secret key to CI logs.
    console.error(`STAGING_PROJECT_BINDING=BLOCKED ${error.message}`);
    process.exitCode = 1;
  }
}
