import { z } from 'zod';
import { rpc } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import { signOut } from './staff';
import type { Requirements } from './staff';

export async function lockSession(): Promise<void> {
  await rpc('lock_staff_session', {}, z.null());
}

export function lockedPage(info: Requirements, onChange: () => Promise<void>): HTMLElement {
  const pin = field('PIN operativo', 'pin', 'password');
  pin.input.inputMode = 'numeric';
  pin.input.pattern = '[0-9]{6,10}';
  pin.input.maxLength = 10;
  pin.input.required = true;
  pin.input.autocomplete = 'off';
  const feedback = el('p', { role: 'alert' });
  const form = el(
    'form',
    { class: 'login-form' },
    el('p', { class: 'eyebrow' }, 'Sessione bloccata'),
    el('h1', {}, info.display_name),
    el(
      'p',
      {},
      info.password_required || !info.pin_enabled
        ? 'Accedi con identificativo e password per riprendere il servizio.'
        : 'Inserisci il tuo PIN per riprendere il servizio.',
    ),
    feedback,
  );
  if (!info.password_required && info.pin_enabled) {
    const submit = el('button', { type: 'submit', class: 'button primary' }, 'Sblocca');
    form.append(pin.root, submit);
    if (info.retry_after_seconds > 0)
      feedback.textContent = `Attendi ${info.retry_after_seconds} secondi prima di riprovare.`;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      void rpc(
        'unlock_staff_session',
        { p_pin: pin.input.value },
        z.object({ ok: z.boolean(), password_required: z.boolean().optional() }),
      )
        .then(async (result) => {
          pin.input.value = '';
          if (result.ok || result.password_required) await onChange();
          else
            feedback.textContent =
              'PIN non valido o attesa ancora attiva. Attendi qualche secondo e riprova.';
        })
        .catch(() => {
          pin.input.value = '';
          feedback.textContent = 'Sblocco non completato. Verifica la connessione e riprova.';
        })
        .finally(() => {
          submit.disabled = false;
        });
    });
  }
  form.append(
    button(
      'Accedi con password',
      async () => {
        await signOut();
        await onChange();
      },
      'secondary',
    ),
  );
  return el(
    'main',
    { id: 'main', class: 'login-panel' },
    el('a', { href: '/', class: 'brand' }, 'Plateform'),
    form,
  );
}

export function editPin(): void {
  const pin = field('Nuovo PIN (6–10 cifre)', 'pin', 'password');
  const confirmation = field('Ripeti PIN', 'pin-confirmation', 'password');
  for (const input of [pin.input, confirmation.input]) {
    input.pattern = '[0-9]{6,10}';
    input.inputMode = 'numeric';
    input.maxLength = 10;
    input.required = true;
    input.autocomplete = 'new-password';
  }
  const feedback = el('p', { role: 'alert' });
  const popup = dialog(
    'Il tuo PIN operativo',
    el(
      'p',
      {},
      'Per impostarlo è necessario aver effettuato l’accesso completo negli ultimi cinque minuti.',
    ),
    pin.root,
    confirmation.root,
    feedback,
  );
  popup.append(
    button('Salva PIN', async () => {
      if (!pin.input.reportValidity() || !confirmation.input.reportValidity()) return;
      if (pin.input.value !== confirmation.input.value) {
        feedback.textContent = 'I PIN non coincidono.';
        return;
      }
      await rpc('set_staff_pin', { p_pin: pin.input.value }, z.null());
      pin.input.value = '';
      confirmation.input.value = '';
      popup.close();
      toast('PIN aggiornato.');
    }),
  );
}
