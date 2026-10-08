import { button, dialog, el } from '../components/dom';
export async function registerPwa(): Promise<void> {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const base = import.meta.env.BASE_URL;
  const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
  let notified = false;
  function offerUpdate() {
    if (!registration.waiting || notified) return;
    notified = true;
    const notice = el(
      'aside',
      { class: 'pwa-update', role: 'status' },
      el('span', {}, 'È disponibile un aggiornamento.'),
      button(
        'Aggiorna quando pronto',
        () => {
          if (document.querySelector('dialog[open]')) {
            dialog(
              'Completa l’operazione aperta',
              el('p', {}, 'Chiudi o completa le finestre operative prima di aggiornare.'),
            );
            return;
          }
          registration.waiting?.postMessage('ACTIVATE_UPDATE');
        },
        'secondary',
      ),
    );
    document.body.append(notice);
  }
  offerUpdate();
  registration.addEventListener('updatefound', () =>
    registration.installing?.addEventListener('statechange', () => {
      if (registration.installing?.state === 'installed' && navigator.serviceWorker.controller)
        offerUpdate();
    }),
  );
  let refreshed = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshed) {
      refreshed = true;
      location.reload();
    }
  });
}
