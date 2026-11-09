import { safeError } from '../api/client';
import { hubHealth, hubLink, normalizeHubUrl, saveHubLink } from '../api/venue-hub';
import { button, el, field, toast } from '../components/dom';
import { connectivitySummary, probeConnectivity } from '../services/connectivity';

// Association of this device with the venue hub (ADR-0001). The pairing code is
// issued by the hub installation for this device and user; it is a credential:
// never shown again after saving, never sent anywhere except the hub.
export async function venueHubPage(): Promise<HTMLElement> {
  const statusBox = el('div', { class: 'card', role: 'status', 'aria-live': 'polite' });
  const renderStatus = async () => {
    statusBox.replaceChildren(el('p', { class: 'muted' }, 'Verifica dei collegamenti in corso…'));
    const state = await probeConnectivity();
    const summary = connectivitySummary(state);
    statusBox.replaceChildren(
      el('h2', {}, summary.text),
      el('ul', { class: 'plain-list' }, ...summary.detail.map((line) => el('li', {}, line))),
      el(
        'p',
        { class: 'muted' },
        `Ultima verifica: ${new Date(state.checkedAt).toLocaleTimeString('it-IT')}`,
      ),
    );
  };

  const current = hubLink();
  const url = field('Indirizzo dell’hub', 'hub-url', 'url', current?.url ?? '');
  url.input.placeholder = 'https://hub.ristorante.lan:8443';
  url.input.autocomplete = 'off';
  const code = field('Codice di associazione del dispositivo', 'hub-code', 'password');
  code.input.autocomplete = 'off';
  const label = field('Nome della postazione', 'hub-label', 'text', current?.label ?? '');
  label.input.maxLength = 80;

  const save = button('Associa questo dispositivo', async () => {
    const origin = normalizeHubUrl(url.input.value);
    if (!origin) {
      toast(
        'Inserisci l’indirizzo HTTPS dell’hub, senza percorso, ad esempio https://hub.ristorante.lan:8443.',
        true,
      );
      url.input.focus();
      return;
    }
    const token = code.input.value.trim();
    if (token.length < 32) {
      toast(
        'Il codice di associazione è incompleto. Copialo di nuovo dall’installazione dell’hub.',
        true,
      );
      code.input.focus();
      return;
    }
    try {
      await hubHealth(origin);
    } catch (error) {
      throw safeError(error);
    }
    saveHubLink({ url: origin, token, ...(label.input.value ? { label: label.input.value } : {}) });
    code.input.value = '';
    toast('Dispositivo associato all’hub di sede. Le operazioni di servizio passano ora dall’hub.');
    await renderStatus();
  });

  const remove = button(
    'Scollega dall’hub',
    async () => {
      saveHubLink(null);
      toast('Il dispositivo non usa più l’hub di sede.');
      await renderStatus();
    },
    'secondary',
  );

  void renderStatus();
  return el(
    'section',
    { class: 'stack' },
    el(
      'p',
      { class: 'muted' },
      'L’hub di sede tiene in comunicazione sala, cucina e cassa anche senza Internet. ',
      'Le operazioni di servizio passano dall’hub e vengono inviate al cloud appena possibile. ',
      'Pagamenti online, rimborsi e funzioni amministrative restano disponibili solo con il cloud.',
    ),
    statusBox,
    el(
      'form',
      { class: 'card stack', novalidate: '' },
      el('h2', {}, current ? 'Associazione attiva' : 'Associa questo dispositivo'),
      url.root,
      code.root,
      label.root,
      el('div', { class: 'row' }, save, current ? remove : null),
    ),
  );
}
