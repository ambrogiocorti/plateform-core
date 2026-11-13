import { z } from 'zod';
import { rpc, safeError } from '../api/client';
import {
  hubHealth,
  hubLink,
  hubStaffSession,
  normalizeHubUrl,
  saveHubLink,
} from '../api/venue-hub';
import { environment } from '../config/environment';
import { button, el, field, toast } from '../components/dom';
import { connectivitySummary, probeConnectivity } from '../services/connectivity';
import type { StaffContext } from './staff-context';

const hubSchema = z.object({
  hub_id: z.string(),
  generation: z.number(),
  applied_seq: z.number(),
  last_ingest_at: z.string().nullable(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
  quarantined: z.number(),
});
const secretSchema = z.object({
  hub_id: z.string(),
  generation: z.number(),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/**
 * Cloud registration of the venue hub (ADMIN only, needs the cloud). The secret
 * is shown once, to be entered in the hub installation together with the ingest
 * address; the database keeps only its SHA-256.
 */
function hubRegistration(context: StaffContext): HTMLElement {
  const venue = context.venue!;
  const list = el('div', { class: 'stack' });
  const reveal = el('div', { class: 'stack' });
  const ingestUrl = `${environment().supabaseUrl.replace(/\/$/, '')}/functions/v1/venue-hub-ingest`;

  const showSecret = (issued: z.infer<typeof secretSchema>) => {
    const copy = (label: string, value: string) =>
      button(
        label,
        async () => {
          await navigator.clipboard.writeText(value);
          toast('Copiato.');
        },
        'secondary',
      );
    reveal.replaceChildren(
      el(
        'div',
        { class: 'card stack', role: 'alert' },
        el('h3', {}, `Chiave dell’hub ${issued.hub_id} (generazione ${issued.generation})`),
        el(
          'p',
          {},
          'Copiala ora nell’installazione dell’hub: non verrà più mostrata. Chi la possiede può inviare dati di questa sede al cloud.',
        ),
        el('code', { class: 'hub-secret' }, issued.secret),
        el('p', { class: 'muted' }, `Indirizzo di invio: ${ingestUrl}`),
        el(
          'div',
          { class: 'row' },
          copy('Copia la chiave', issued.secret),
          copy('Copia l’indirizzo', ingestUrl),
          button('Ho salvato la chiave', () => reveal.replaceChildren(), 'secondary'),
        ),
      ),
    );
  };

  const load = async () => {
    const hubs = await rpc('get_venue_hubs', { p_venue: venue.id }, z.array(hubSchema));
    // One hub per venue: a replacement goes through "Sostituisci l’hub".
    registration.hidden = hubs.length > 0;
    list.replaceChildren(
      ...(hubs.length
        ? hubs.map((hub) =>
            el(
              'div',
              { class: 'card stack' },
              el('h3', {}, hub.hub_id),
              el(
                'p',
                { class: 'muted' },
                hub.last_ingest_at
                  ? `Ultimo invio ricevuto: ${new Date(hub.last_ingest_at).toLocaleString('it-IT')} · generazione ${hub.generation}`
                  : `Nessun invio ricevuto finora · generazione ${hub.generation}`,
              ),
              hub.quarantined > 0
                ? el(
                    'p',
                    { role: 'alert' },
                    `${hub.quarantined} modifiche non accettate dal cloud e messe da parte: contatta l’assistenza.`,
                  )
                : null,
              button(
                'Sostituisci l’hub (nuova chiave)',
                async () => {
                  if (
                    !confirm(
                      'Il vecchio hub non potrà più inviare dati. Procedi solo se lo stai sostituendo o se la chiave è stata persa.',
                    )
                  )
                    return;
                  showSecret(await rpc('promote_venue_hub', { p_hub: hub.hub_id }, secretSchema));
                  await load();
                },
                'secondary',
              ),
            ),
          )
        : [el('p', { class: 'muted' }, 'Nessun hub registrato per questa sede.')]),
    );
  };

  const name = field('Nome dell’hub', 'hub-id', 'text', `hub-${venue.slug}`.slice(0, 63));
  name.input.pattern = '[a-z0-9][a-z0-9-]{2,62}';
  const register = button('Registra l’hub di questa sede', async () => {
    if (!name.input.reportValidity()) return;
    showSecret(
      await rpc(
        'register_venue_hub',
        { p_venue: venue.id, p_hub: name.input.value.trim() },
        secretSchema,
      ),
    );
    await load();
  });

  void load().catch((error: unknown) => {
    list.replaceChildren(el('p', { role: 'alert' }, safeError(error).message));
  });
  const registration = el('div', { class: 'stack' }, name.root, register);
  return el(
    'section',
    { class: 'card stack', 'aria-labelledby': 'hub-registration-title' },
    el('h2', { id: 'hub-registration-title' }, `Hub registrati per ${venue.name}`),
    el(
      'p',
      { class: 'muted' },
      'Per inviare al cloud le operazioni fatte in sede, l’hub deve essere registrato qui. Serve il collegamento a Internet.',
    ),
    reveal,
    list,
    registration,
  );
}

// Association of this device with the venue hub (ADR-0001). The pairing code is
// issued by the hub installation for this device and user; it is a credential:
// never shown again after saving, never sent anywhere except the hub.
export async function venueHubPage(context?: StaffContext): Promise<HTMLElement> {
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
    context?.venue && ['ADMIN', 'SUPER_ADMIN'].includes(context.profile.role) && !hubStaffSession()
      ? hubRegistration(context)
      : null,
  );
}
