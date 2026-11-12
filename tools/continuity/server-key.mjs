function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

export function assertSupabaseServerKey(name, raw) {
  const value = String(raw ?? '').trim();
  if (!value || /^REPLACE(?:_|$)/i.test(value)) throw new Error(`CONFIG_REQUIRED:${name}`);
  if (value.startsWith('sb_publishable_')) throw new Error(`CONFIG_SERVER_KEY_REQUIRED:${name}`);
  if (value.startsWith('sb_secret_')) {
    if (value.length < 24) throw new Error(`CONFIG_INVALID:${name}`);
    return value;
  }
  const parts = value.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(decodeBase64Url(parts[1]));
      if (payload?.role === 'service_role') return value;
      throw new Error(`CONFIG_SERVER_KEY_REQUIRED:${name}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CONFIG_')) throw error;
      throw new Error(`CONFIG_INVALID:${name}`, { cause: error });
    }
  }
  throw new Error(`CONFIG_INVALID:${name}`);
}
