import { client, safeError } from '../api/client';
import { el, field } from '../components/dom';

/** What an e-mail link (password recovery or invitation) carried in the URL fragment. */
export type EmailLink =
  { kind: 'session'; accessToken: string; refreshToken: string } | { kind: 'expired' };

/** GoTrue sends recovery and invite links back as `#access_token=…&type=recovery`. The client
 * keeps detectSessionInUrl off, so only these two link types are ever read from the URL. */
export function readEmailLink(hash: string): EmailLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.get('error_code') === 'otp_expired' || params.get('error') === 'access_denied')
    return { kind: 'expired' };
  const type = params.get('type');
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if ((type !== 'recovery' && type !== 'invite') || !accessToken || !refreshToken) return null;
  return { kind: 'session', accessToken, refreshToken };
}

function layout(panel: HTMLElement): HTMLElement {
  return el(
    'main',
    { id: 'main', class: 'login-layout' },
    el(
      'section',
      { class: 'login-story' },
      el(
        'a',
        { href: import.meta.env.BASE_URL.replace(/staff\/$/, ''), class: 'brand' },
        'Plateform',
      ),
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, 'People. Food. Service. Together.'),
        el('h1', {}, 'Ogni dettaglio.', el('br'), el('span', {}, 'Un grande servizio.')),
      ),
      el('footer', { class: 'muted' }, 'Restaurant operating system'),
    ),
    el('section', { class: 'login-panel' }, panel),
  );
}

function notice(title: string, text: string): HTMLElement {
  return layout(
    el('div', { class: 'login-form' }, el('h2', {}, title), el('p', { class: 'muted' }, text)),
  );
}

/** Lands an e-mail link: the person chooses a password, then signs in normally (MFA included). */
export async function emailLinkPage(
  link: EmailLink,
  onDone: (message: string) => Promise<void>,
): Promise<HTMLElement> {
  if (link.kind === 'expired')
    return notice(
      'Link scaduto',
      'Il link per scegliere la password non è più valido. Chiedi all’amministratore di inviartene uno nuovo.',
    );
  const { error: sessionError } = await client().auth.setSession({
    access_token: link.accessToken,
    refresh_token: link.refreshToken,
  });
  if (sessionError)
    return notice(
      'Link non valido',
      'Il link è già stato usato o non è più valido. Chiedi all’amministratore di inviartene uno nuovo.',
    );
  const password = field('Nuova password', 'new-password', 'password');
  password.input.required = true;
  password.input.minLength = 12;
  password.input.maxLength = 1024;
  password.input.autocomplete = 'new-password';
  const confirm = field('Ripeti la password', 'confirm-password', 'password');
  confirm.input.required = true;
  confirm.input.minLength = 12;
  confirm.input.maxLength = 1024;
  confirm.input.autocomplete = 'new-password';
  const feedback = el('p', { role: 'alert', class: 'muted' });
  const submit = el('button', { type: 'submit', class: 'button primary' }, 'Salva la password');
  const form = el(
    'form',
    { class: 'login-form' },
    el('p', { class: 'eyebrow' }, 'Area riservata'),
    el('h2', {}, 'Scegli la tua password'),
    el(
      'p',
      { class: 'muted' },
      'Almeno 12 caratteri. Dopo averla salvata accedi con la tua email.',
    ),
    password.root,
    confirm.root,
    feedback,
    submit,
  );
  // A mismatch flagged on a previous attempt must not block the next native form submission.
  for (const input of [password.input, confirm.input])
    input.addEventListener('input', () => confirm.input.setCustomValidity(''));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    confirm.input.setCustomValidity(
      password.input.value === confirm.input.value ? '' : 'Le password non coincidono.',
    );
    if (!form.reportValidity() || submit.disabled) return;
    submit.disabled = true;
    feedback.textContent = '';
    const next = password.input.value;
    password.input.value = '';
    confirm.input.value = '';
    void (async () => {
      const { error } = await client().auth.updateUser({ password: next });
      if (error) throw safeError(error);
      // The e-mail session only proves access to the mailbox: sign in again so the normal login
      // records the device and enforces MFA.
      await client().auth.signOut({ scope: 'local' });
      await onDone('Password salvata. Ora accedi con la tua email e la nuova password.');
    })()
      .catch((error: unknown) => {
        feedback.textContent = safeError(error).message;
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
  return layout(form);
}
