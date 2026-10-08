import { assertSupabaseServerKey } from '../tools/continuity/server-key.mjs';

function legacy(role) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ role, iss: 'supabase' })}.signature`;
}
const good = ['sb_secret_abcdefghijklmnopqrstuvwxyz123456', legacy('service_role')];
for (const value of good)
  if (assertSupabaseServerKey('TEST', value) !== value)
    throw new Error('SERVER_KEY_VALID_REJECTED');
for (const value of [
  'REPLACE_SERVER_SECRET',
  'sb_publishable_abcdefghijklmnopqrstuvwxyz123456',
  legacy('anon'),
  'not-a-key',
]) {
  let blocked = false;
  try {
    assertSupabaseServerKey('TEST', value);
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error(`SERVER_KEY_INVALID_ACCEPTED:${value.slice(0, 18)}`);
}
console.log('STEP12_CONTINUITY_SERVER_KEY_VALIDATION=PASSED');
