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

export async function claimRetention(config) {
  return await rpc(config, 'claim_backup_retention_job', { p_lease_seconds: config.leaseSeconds });
}

export async function finishRetention(config, input) {
  return await rpc(config, 'finish_backup_retention_job', {
    p_id: input.id,
    p_lease: input.leaseToken,
    p_success: input.success,
    p_error_code: input.errorCode ?? null,
  });
}
