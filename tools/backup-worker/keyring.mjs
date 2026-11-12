const KEY_ID = /^[A-Za-z0-9._:-]{3,160}$/;

export function decodeKey32(raw, label = 'ENCRYPTION_KEY') {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`CONFIG_REQUIRED:${label}`);
  const source = raw.trim();
  const value = Buffer.from(source, 'base64');
  if (
    value.length !== 32 ||
    value.toString('base64').replace(/=+$/, '') !== source.replace(/=+$/, '')
  )
    throw new Error(`CONFIG_INVALID:${label}`);
  return value;
}

export function loadEncryptionKeyring(
  activeId,
  activeRaw,
  keyringRaw = process.env.PLATEFORM_BACKUP_KEYRING_JSON,
) {
  if (!KEY_ID.test(String(activeId ?? '')))
    throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_ENCRYPTION_KEY_ID');
  const keys = new Map([
    [activeId, decodeKey32(activeRaw, 'PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64')],
  ]);
  if (keyringRaw?.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(keyringRaw);
    } catch {
      throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_KEYRING_JSON');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
      throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_KEYRING_JSON');
    const entries = Object.entries(parsed);
    if (entries.length > 32) throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_KEYRING_JSON');
    for (const [id, raw] of entries) {
      if (!KEY_ID.test(id) || typeof raw !== 'string')
        throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_KEYRING_JSON');
      const key = decodeKey32(raw, 'PLATEFORM_BACKUP_KEYRING_JSON');
      const existing = keys.get(id);
      if (existing && !existing.equals(key)) throw new Error('CONFIG_KEYRING_ACTIVE_KEY_MISMATCH');
      keys.set(id, key);
    }
  }
  return keys;
}

export function resolveEncryptionKey(keyring, keyId) {
  if (!KEY_ID.test(String(keyId ?? ''))) throw new Error('BACKUP_ENCRYPTION_KEY_ID_INVALID');
  const key = keyring.get(String(keyId));
  if (!key) throw new Error(`BACKUP_ENCRYPTION_KEY_UNAVAILABLE:${keyId}`);
  return key;
}
