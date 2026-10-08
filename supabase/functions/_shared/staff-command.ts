import { secret } from './http.ts';

export async function staffPasswordFingerprint(job: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret('RATE_LIMIT_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(JSON.stringify(['plateform-staff-password-v1', job, password])),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

// Only reviewed application codes leave the server. Never relay SQL details or Auth errors.
export function staffCommandError(error: { message: string }): Error {
  const allowed = [
    'FORBIDDEN',
    'STAFF_MANAGEMENT_FORBIDDEN',
    'STAFF_IDENTIFIER_TAKEN',
    'STAFF_COMMAND_PENDING',
    'STAFF_ALREADY_ACTIVE',
    'STAFF_DISABLED',
    'INVALID_STAFF_COMMAND',
    'STAFF_LIMIT',
    'SCOPE_ESCALATION',
    'VENUE_FORBIDDEN',
    'VENUE_ASSIGNMENT_REQUIRED',
    'STEP_UP_REQUIRED',
    'IDEMPOTENCY_MISMATCH',
    'OPERATION_IN_PROGRESS',
    'IDENTITY_VERIFICATION_REQUIRED',
  ];
  return new Error(allowed.includes(error.message) ? error.message : 'REQUEST_FAILED');
}
