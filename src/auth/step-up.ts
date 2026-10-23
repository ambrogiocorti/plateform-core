import { z } from 'zod';
import { ApplicationError, client, safeEdgeError } from '../api/client';
import { button, dialog, el, field } from '../components/dom';

// A wrong password is the one step-up failure the person fixes on the spot, so say so plainly.
export async function stepUpError(error: unknown): Promise<ApplicationError> {
  const failure = await safeEdgeError(error);
  const context =
    error !== null && typeof error === 'object' && 'context' in error ? error.context : null;
  const payload: unknown =
    context instanceof Response
      ? await context
          .clone()
          .json()
          .catch(() => null)
      : null;
  const code = z.object({ code: z.string() }).safeParse(payload);
  return code.success && code.data.code === 'UNAUTHORIZED'
    ? new ApplicationError('UNAUTHORIZED', failure.requestId, 'Password non corretta.')
    : failure;
}

export function stepUp(action: string, resource: string | null = null): Promise<string> {
  return new Promise((resolve, reject) => {
    const password = field('La tua password', 'admin-password', 'password');
    password.input.autocomplete = 'current-password';
    password.input.required = true;
    let completed = false;
    const confirmation = dialog(
      'Conferma la tua identità',
      el('p', {}, 'Questa operazione richiede una nuova verifica della password del tuo account.'),
      password.root,
    );
    confirmation.addEventListener('close', () => {
      if (!completed) reject(new Error('Operazione annullata.'));
    });
    confirmation.append(
      button('Conferma identità', async () => {
        if (!password.input.reportValidity()) return;
        const secret = password.input.value;
        password.input.value = '';
        const { data, error } = await client().functions.invoke('step-up', {
          body: { password: secret, action, resource_id: resource },
        });
        if (error) throw await stepUpError(error);
        const grant = z.object({ grant_id: z.uuid() }).parse(data);
        completed = true;
        confirmation.close();
        resolve(grant.grant_id);
      }),
    );
  });
}
