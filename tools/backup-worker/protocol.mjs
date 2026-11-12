function rpcUrl(config, fn) {
  return `${config.supabaseUrl}/rest/v1/rpc/${encodeURIComponent(fn)}`;
}

async function rpc(config, fn, body) {
  const response = await fetch(rpcUrl(config, fn), {
    method: 'POST',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`RPC_FAILED:${fn}:${response.status}:${text.slice(0, 240)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`RPC_INVALID_RESPONSE:${fn}`);
  }
}

export async function claimBackup(config) {
  return await rpc(config, 'claim_backup_job', { p_lease_seconds: config.leaseSeconds });
}

export async function finishBackup(config, input) {
  return await rpc(config, 'finish_backup_job', {
    p_id: input.id,
    p_lease: input.leaseToken,
    p_success: input.success,
    p_database_reference: input.databaseReference ?? null,
    p_auth_reference: input.authReference ?? null,
    p_storage_reference: input.storageReference ?? null,
    p_manifest: input.manifest ?? {},
    p_verification: input.verification ?? {},
    p_checksum: input.checksum ?? null,
    p_size_bytes: input.sizeBytes ?? null,
    p_object_count: input.objectCount ?? null,
    p_encryption_key_id: input.encryptionKeyId ?? null,
    p_error_code: input.errorCode ?? null,
  });
}

export async function backupMetadata(config, id) {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/backup_metadata?id=eq.${encodeURIComponent(id)}&select=id,status,checksum,integrity_verified,error_code`,
    {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'X-Request-Id': crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(`BACKUP_STATE_QUERY_FAILED:${response.status}:${text.slice(0, 240)}`);
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error('BACKUP_STATE_INVALID_RESPONSE');
  }
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('BACKUP_STATE_NOT_FOUND');
  return rows[0];
}

export async function finishBackupSuccess(config, input) {
  try {
    await finishBackup(config, { ...input, success: true });
    return { reconciled: false };
  } catch (commitError) {
    let state;
    try {
      state = await backupMetadata(config, input.id);
    } catch (stateError) {
      throw new AggregateError([commitError, stateError], 'BACKUP_COMMIT_AMBIGUOUS', {
        cause: stateError,
      });
    }
    if (state.status === 'SUCCEEDED') {
      if (state.integrity_verified === true && state.checksum === input.checksum)
        return { reconciled: true };
      throw new AggregateError([commitError], 'BACKUP_COMMIT_STATE_MISMATCH', {
        cause: commitError,
      });
    }
    throw commitError;
  }
}
