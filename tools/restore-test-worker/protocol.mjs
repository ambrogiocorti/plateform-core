async function request(config, path, options = {}) {
  const response = await fetch(`${config.sourceUrl}${path}`, {
    ...options,
    headers: {
      apikey: config.sourceServiceRoleKey,
      Authorization: `Bearer ${config.sourceServiceRoleKey}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SOURCE_API_FAILED:${response.status}:${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}
async function rpc(config, fn, body) {
  return await request(config, `/rest/v1/rpc/${encodeURIComponent(fn)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
export async function claimRestoreTest(config) {
  return await rpc(config, 'claim_restore_test_job', { p_lease_seconds: config.leaseSeconds });
}
export async function markVerifying(config, id, lease, targetReference) {
  return await rpc(config, 'mark_restore_verifying', {
    p_id: id,
    p_lease: lease,
    p_target_reference: targetReference,
  });
}
export async function finishRestore(config, id, lease, success, verification, errorCode = null) {
  return await rpc(config, 'finish_restore_job', {
    p_id: id,
    p_lease: lease,
    p_success: success,
    p_verification: verification,
    p_error_code: errorCode,
  });
}
export async function backupMetadata(config, id) {
  const rows = await request(
    config,
    `/rest/v1/backup_metadata?id=eq.${encodeURIComponent(id)}&select=id,status,database_reference,auth_reference,storage_reference,manifest,checksum,integrity_verified,encryption_key_id`,
  );
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('BACKUP_METADATA_NOT_FOUND');
  return rows[0];
}
