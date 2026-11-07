import { client } from '../api/client';
import { button, el, field, toast } from '../components/dom';

// These links are intentionally handled by the browser, never redeemed by a GET request.
// GoTrue URL auto-detection is off: the fragment/query is scrubbed before any UI is shown.
export type RecoveryIntent =
  | { kind: 'session'; accessToken: string; refreshToken: string }
  | { kind: 'token'; tokenHash: string }
  | { kind: 'expired' };

export function consumePasswordRecoveryIntent(): RecoveryIntent | null {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const type = fragment.get('type') ?? url.searchParams.get('type');
  let result: RecoveryIntent | null = null;
  if (fragment.get('error_code') === 'otp_expired' || fragment.get('error') === 'access_denied') {
    result = { kind: 'expired' };
  } else if (type === 'recovery' && fragment.get('access_token') && fragment.get('refresh_token')) {
    result = {
      kind: 'session',
      accessToken: fragment.get('access_token')!,
      refreshToken: fragment.get('refresh_token')!,
    };
  } else if (type === 'recovery' && url.searchParams.get('token_hash')) {
    result = { kind: 'token', tokenHash: url.searchParams.get('token_hash')! };
  }
  if (result) history.replaceState(history.state, '', url.pathname);
  return result;
}

function recoveryShell(...children: HTMLElement[]): HTMLElement {
  return el(
    'main',
    { id: 'main', class: 'login-layout', tabindex: '-1' },
    el(
      'section',
      { class: 'login-story' },
      el('a', { href: '/', class: 'brand' }, 'Plateform'),
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, 'Accesso sicuro'),
        el('h1', {}, 'Il tuo account.'),
      ),
    ),
    el('section', { class: 'login-panel' }, el('div', { class: 'login-form' }, ...children)),
  );
}

function expiredPage(): HTMLElement {
  return recoveryShell(
    el('h2', {}, 'Link scaduto'),
    el('p', {}, 'Il collegamento non è più valido. Richiedi un nuovo link all’amministratore.'),
    el('a', { href: '/login', class: 'button secondary' }, 'Torna all’accesso'),
  );
}

function passwordForm(onComplete: () => void): HTMLElement {
  const password = field('Nuova password', 'new_password', 'password');
  const repeat = field('Ripeti la password', 'new_password_repeat', 'password');
  for (const input of [password.input, repeat.input]) {
    input.required = true;
    input.autocomplete = 'new-password';
    input.minLength = 8;
  }
  const feedback = el('p', { role: 'alert', class: 'muted' });
  const save = button('Salva la password', async () => {
    feedback.textContent = '';
    if (!password.input.value || password.input.value.length < 8) {
      feedback.textContent = 'La password deve contenere almeno 8 caratteri.';
      return;
    }
    if (password.input.value !== repeat.input.value) {
      feedback.textContent = 'Le password non coincidono.';
      return;
    }
    const { error } = await client().auth.updateUser({ password: password.input.value });
    password.input.value = '';
    repeat.input.value = '';
    if (error) {
      feedback.textContent =
        'Non è stato possibile aggiornare la password. Richiedi un nuovo link.';
      return;
    }
    await client().auth.signOut({ scope: 'local' });
    toast('Password salvata.');
    onComplete();
  });
  const form = el(
    'form',
    { class: 'login-form' },
    el('h2', {}, 'Scegli la tua password'),
    el('p', { class: 'muted' }, 'Imposta una password personale per accedere a Plateform.'),
    password.root,
    repeat.root,
    feedback,
    save,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save.click();
  });
  return recoveryShell(form);
}

export async function passwordRecoveryPage(
  intent: RecoveryIntent,
  onComplete: () => void,
): Promise<HTMLElement> {
  if (intent.kind === 'expired') return expiredPage();
  if (intent.kind === 'session') {
    const { data, error } = await client().auth.setSession({
      access_token: intent.accessToken,
      refresh_token: intent.refreshToken,
    });
    return error || !data.session ? expiredPage() : passwordForm(onComplete);
  }
  const stage = el('div', { class: 'login-form' });
  const continueButton = button('Continua', async () => {
    const { data, error } = await client().auth.verifyOtp({
      token_hash: intent.tokenHash,
      type: 'recovery',
    });
    if (error || !data.session) {
      stage.replaceChildren(
        el('h2', {}, 'Link scaduto'),
        el('p', {}, 'Richiedi un nuovo collegamento.'),
      );
      return;
    }
    const recovered = passwordForm(onComplete);
    // Keep a single main landmark in the page while changing the recovery stage.
    stage.closest('main')?.replaceWith(recovered);
  });
  stage.append(
    el('h2', {}, 'Conferma il recupero'),
    el('p', {}, 'Premi Continua per usare il link e scegliere una nuova password.'),
    continueButton,
  );
  return recoveryShell(stage);
}
