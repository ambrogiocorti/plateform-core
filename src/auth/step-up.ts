import { z } from 'zod';
import { client } from '../api/client';
import { button, dialog, el, field } from '../components/dom';

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
        if (error) throw error;
        const grant = z.object({ grant_id: z.uuid() }).parse(data);
        completed = true;
        confirmation.close();
        resolve(grant.grant_id);
      }),
    );
  });
}
