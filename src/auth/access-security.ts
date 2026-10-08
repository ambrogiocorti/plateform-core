import { z } from 'zod';
import { client, rpc } from '../api/client';
import { button, dialog, el, field, status, toast } from '../components/dom';
import { stepUp } from './step-up';

const workspaceSchema = z.object({
  session_id: z.uuid(),
  sessions: z.array(
    z.object({
      id: z.uuid(),
      device_name: z.string().nullable(),
      created_at: z.string(),
      unlocked_until: z.string(),
      current: z.boolean(),
    }),
  ),
  devices: z.array(
    z.object({
      id: z.uuid(),
      display_name: z.string(),
      platform: z.string(),
      last_seen_at: z.string().nullable(),
      revoked_at: z.string().nullable(),
      current: z.boolean(),
    }),
  ),
});

async function invokePasswordChange(password: string): Promise<void> {
  const grant = await stepUp('CHANGE_PASSWORD', null);
  const { error } = await client().functions.invoke('staff-admin', {
    body: {
      action: 'CHANGE_PASSWORD',
      idempotency_key: crypto.randomUUID(),
      grant_id: grant,
      password,
    },
  });
  if (error) throw error;
}

export async function openAccessSecurity(onSignedOut: () => Promise<void>): Promise<void> {
  const data = await rpc('get_own_access_sessions', {}, workspaceSchema);
  const content = el('div', { class: 'stack' });
  const popup = dialog('Sicurezza account', content);

  const password = field('Nuova password', 'profile-new-password', 'password');
  password.input.minLength = 12;
  password.input.maxLength = 1024;
  password.input.autocomplete = 'new-password';
  const confirm = field('Ripeti nuova password', 'profile-confirm-password', 'password');
  confirm.input.minLength = 12;
  confirm.input.maxLength = 1024;
  confirm.input.autocomplete = 'new-password';
  content.append(
    el('h3', {}, 'Password'),
    el(
      'p',
      { class: 'muted' },
      'La modifica richiede una nuova verifica della password attuale e invalida le sessioni operative precedenti.',
    ),
    password.root,
    confirm.root,
    button('Cambia password', async () => {
      if (!password.input.reportValidity() || !confirm.input.reportValidity()) return;
      confirm.input.setCustomValidity(
        password.input.value === confirm.input.value ? '' : 'Le password non coincidono.',
      );
      if (!confirm.input.reportValidity()) return;
      const next = password.input.value;
      password.input.value = '';
      confirm.input.value = '';
      await invokePasswordChange(next);
      popup.close();
      toast('Password aggiornata. Accedi nuovamente.');
      await onSignedOut();
    }),
    el('h3', {}, 'Sessioni attive'),
  );

  if (!data.sessions.length)
    content.append(el('p', { class: 'muted' }, 'Nessuna sessione operativa attiva.'));
  for (const session of data.sessions) {
    const line = el(
      'article',
      { class: 'card row between' },
      el(
        'div',
        {},
        el('strong', {}, session.device_name ?? 'Browser'),
        el(
          'p',
          { class: 'muted' },
          `Avviata ${new Date(session.created_at).toLocaleString('it-IT')}`,
        ),
        session.current ? status('SESSIONE CORRENTE') : null,
      ),
    );
    line.append(
      button(
        session.current ? 'Esci da questa sessione' : 'Revoca sessione',
        async () => {
          const grant = await stepUp('SESSION_REVOKE', session.id);
          await rpc('revoke_staff_session', { p_session: session.id, p_grant: grant }, z.null());
          if (session.current) {
            popup.close();
            await onSignedOut();
          } else {
            line.remove();
            toast('Sessione revocata.');
          }
        },
        session.current ? 'danger' : 'secondary',
      ),
    );
    content.append(line);
  }

  content.append(el('h3', {}, 'Dispositivi registrati'));
  if (!data.devices.length)
    content.append(el('p', { class: 'muted' }, 'Nessun dispositivo registrato.'));
  for (const device of data.devices) {
    const line = el(
      'article',
      { class: 'card row between' },
      el(
        'div',
        {},
        el('strong', {}, device.display_name),
        el(
          'p',
          { class: 'muted' },
          `${device.platform}${device.last_seen_at ? ` · ultimo contatto ${new Date(device.last_seen_at).toLocaleString('it-IT')}` : ''}`,
        ),
        device.revoked_at
          ? status('REVOCATO')
          : device.current
            ? status('QUESTO DISPOSITIVO')
            : status('ATTIVO'),
      ),
    );
    if (!device.revoked_at)
      line.append(
        button(
          'Revoca dispositivo',
          async () => {
            const grant = await stepUp('DEVICE_REVOKE', device.id);
            await rpc('revoke_device', { p_device: device.id, p_grant: grant }, z.null());
            if (device.current) {
              popup.close();
              await onSignedOut();
            } else {
              line.replaceWith(el('p', { class: 'muted' }, `${device.display_name} · revocato`));
              toast('Dispositivo revocato.');
            }
          },
          'secondary',
        ),
      );
    content.append(line);
  }
}
