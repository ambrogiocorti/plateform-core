import { safeError } from '../api/client';
import { hubLink, hubStaffList, openHubStaffSession } from '../api/venue-hub';
import type { HubStaffMember } from '../api/venue-hub';
import { button, el, field } from '../components/dom';

// "Accesso in sede": on a device paired with the venue hub, a person picks
// their name and enters their PIN. The hub checks it with the database unlock
// rules (attempt counter, progressive lock) and only for people who completed a
// full login with password within the allowed window. It works without the
// cloud; a new full login (password, MFA) always needs the cloud.

const roleLabels: Record<string, string> = {
  ADMIN: 'Amministrazione',
  WAITER: 'Sala',
  CASHIER: 'Cassa',
  KITCHEN_ADMIN: 'Responsabile cucina',
  KITCHEN_STAFF: 'Cucina',
  PASS: 'Pass',
  HOST: 'Accoglienza',
};

export function hubLoginPage(
  onUnlocked: () => Promise<void>,
  onPasswordLogin: () => void,
): HTMLElement {
  const list = el('div', { class: 'hub-login-people', role: 'list' });
  const feedback = el('p', { role: 'alert', class: 'muted' });
  const stage = el('div', { class: 'stack hub-login-stage' }, list);
  const form = el(
    'section',
    { class: 'login-form-v5 hub-login', 'aria-labelledby': 'hub-login-title' },
    el('p', { class: 'eyebrow' }, `Accesso in sede · ${hubLink()?.label ?? 'Hub di sede'}`),
    el('h2', { id: 'hub-login-title' }, 'Chi inizia il servizio?'),
    el(
      'p',
      { class: 'muted login-form-intro' },
      'Scegli il tuo nome e inserisci il PIN. Funziona anche quando internet non è disponibile.',
    ),
    feedback,
    stage,
    button('Accedi con email e password', onPasswordLogin, 'secondary'),
  );

  function askPin(person: HubStaffMember) {
    const pin = field('PIN', 'pin', 'password');
    pin.input.inputMode = 'numeric';
    pin.input.pattern = '[0-9]{6,10}';
    pin.input.maxLength = 10;
    pin.input.required = true;
    pin.input.autocomplete = 'off';
    const submit = el('button', { type: 'submit', class: 'button primary' }, 'Inizia');
    const pinForm = el(
      'form',
      { class: 'stack hub-login-pin' },
      el('h3', {}, person.display_name),
      pin.root,
      submit,
      button(
        'Cambia persona',
        () => {
          feedback.textContent = '';
          stage.replaceChildren(list);
        },
        'secondary',
      ),
    );
    pinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (submit.disabled || !pin.input.reportValidity()) return;
      submit.disabled = true;
      feedback.textContent = '';
      const value = pin.input.value;
      pin.input.value = '';
      void openHubStaffSession(person.id, value)
        .then(onUnlocked)
        .catch((error: unknown) => {
          feedback.textContent = safeError(error).message;
        })
        .finally(() => {
          submit.disabled = false;
        });
    });
    stage.replaceChildren(pinForm);
    pin.input.focus();
  }

  void hubStaffList()
    .then((people) => {
      if (!people.length) {
        feedback.textContent = 'Nessun membro dello staff è abilitato per questa sede.';
        return;
      }
      list.replaceChildren(
        ...people.map((person) =>
          el(
            'div',
            { role: 'listitem' },
            button(
              `${person.display_name} · ${roleLabels[person.role] ?? person.role}`,
              () => askPin(person),
              'secondary hub-login-person',
            ),
          ),
        ),
      );
    })
    .catch((error: unknown) => {
      feedback.textContent = safeError(error).message;
    });

  return el(
    'main',
    { id: 'main', class: 'login-layout login-layout-v5 hub-login-layout', tabindex: '-1' },
    el(
      'section',
      { class: 'login-panel' },
      el(
        'div',
        { class: 'login-panel-content' },
        el(
          'div',
          { class: 'login-panel-topline' },
          el('span', {}, 'PLATEFORM'),
          el('span', {}, 'Accesso in sede'),
        ),
        form,
        el('p', { class: 'login-panel-security' }, 'Area riservata al personale autorizzato.'),
      ),
    ),
  );
}
