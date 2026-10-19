// Staging counterpart of tests/e2e-live/stack: the same restaurant fixture, seeded on a hosted
// Supabase STAGING project through the Management API (SQL) and GoTrue admin (users). Auth for
// api.supabase.com is supplied by the caller's environment (e.g. a proxy-injected token); keys
// are read at runtime and never written to disk or logs. Never point this at Development or
// production.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fixtureSql, staff, ids } from '../e2e-live/stack/seed.mjs';

export { staff, ids };
// Staging-only extra member: a venue admin, who must pass TOTP MFA (admin_mfa_required).
export const admin = {
  email: 'admin@staff.e2e.test',
  name: 'Anna Admin',
  role: 'ADMIN',
  landing: '/',
};
export const ref = process.env.PLATEFORM_STAGING_REF ?? '';
if (!/^[a-z0-9]{20}$/.test(ref) || ref === 'abdxvlykasqmknexxhjo')
  throw new Error('PLATEFORM_STAGING_REF must name a disposable staging project');
export const supabaseUrl = `https://${ref}.supabase.co`;
// One random password per run: staging is reachable from the internet, so no fixed credential.
export const password =
  process.env.E2E_STAGING_PASSWORD ?? `St-${randomBytes(18).toString('base64url')}`;
process.env.E2E_STAGING_PASSWORD = password;

function api(path, body) {
  const args = ['-sS', '-m', '120', `https://api.supabase.com${path}`];
  if (body !== undefined)
    args.push('-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-');
  for (let attempt = 0; ; attempt++) {
    const out = execFileSync('curl', args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    if (out.includes('Too Many Requests') && attempt < 10) {
      execFileSync('sleep', ['30']);
      continue;
    }
    return JSON.parse(out);
  }
}

/** psql -At equivalent: rows joined by newline, columns by '|'. Throws on SQL errors. */
export function sql(text) {
  const result = api(`/v1/projects/${ref}/database/query`, { query: text });
  if (!Array.isArray(result))
    throw new Error(`SQL failed: ${result.message ?? JSON.stringify(result)}`);
  return result
    .map((row) =>
      Object.values(row)
        .map((v) => (v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)))
        .join('|'),
    )
    .join('\n');
}

export function anonKey() {
  return api(`/v1/projects/${ref}/api-keys`).find((k) => k.name === 'anon').api_key;
}

async function ensureUser(member, serviceKey) {
  const headers = {
    authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    'content-type': 'application/json',
  };
  const existing = sql(`select id from auth.users where email='${member.email}'`);
  const response = await fetch(
    `${supabaseUrl}/auth/v1/admin/users${existing ? `/${existing}` : ''}`,
    {
      method: existing ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify({ email: member.email, password, email_confirm: true }),
    },
  );
  if (!response.ok)
    throw new Error(`GoTrue user ${member.email}: ${response.status} ${await response.text()}`);
  return (await response.json()).id;
}

export async function seed() {
  const serviceKey = api(`/v1/projects/${ref}/api-keys?reveal=true`).find(
    (k) => k.name === 'service_role',
  ).api_key;
  const users = {};
  for (const [key, member] of Object.entries(staff))
    users[key] = await ensureUser(member, serviceKey);
  users.admin = await ensureUser(admin, serviceKey);
  // Each run starts with no TOTP factor, so the enrollment path is exercised every time.
  sql(`delete from auth.mfa_factors where user_id='${users.admin}'`);
  if (sql(`select count(*) from public.venues where id='${ids.venue}'`) === '0')
    sql(fixtureSql(users));
  sql(`insert into public.staff_profiles(id,display_name,role,scope)
      values('${users.admin}','${admin.name}','ADMIN','VENUE') on conflict (id) do nothing;
    insert into public.staff_venue_assignments(user_id,venue_id)
      values('${users.admin}','${ids.venue}') on conflict do nothing;`);
  return users;
}
