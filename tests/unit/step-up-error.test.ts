import { describe, expect, it } from 'vitest';
import { stepUpError } from '../../src/auth/step-up';

const edgeFailure = (code: string) => ({
  context: new Response(JSON.stringify({ code, request_id: 'req-1' }), { status: 400 }),
});

describe('step-up errors', () => {
  it('says the password is wrong instead of blaming the connection', async () => {
    const error = await stepUpError(edgeFailure('UNAUTHORIZED'));
    expect(error.message).toBe('Password non corretta.');
  });

  it('asks to wait when too many confirmations were made', async () => {
    const error = await stepUpError(edgeFailure('RATE_LIMITED'));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.message).toBe('Troppe richieste ravvicinate. Attendi qualche minuto e riprova.');
  });
});
