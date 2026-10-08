import { z } from 'zod';
import { rpc } from '../api/client';
import { button, dialog, el, field, status, toast } from '../components/dom';
import { stepUp } from '../auth/step-up';
import type { StaffContext } from './staff-context';
const reservationSchema = z.object({
  id: z.uuid(),
  first_name: z.string(),
  last_name: z.string(),
  phone: z.string(),
  service_date: z.string(),
  slot_time: z.string(),
  status: z.string(),
  version: z.number().int(),
  anonymized_at: z.string().nullable(),
  privacy_hold: z.boolean(),
  privacy_hold_reason: z.string().nullable(),
});
type Reservation = z.infer<typeof reservationSchema>;
export async function privacyPage(context: StaffContext): Promise<HTMLElement> {
  const view = el('div', { class: 'stack' }),
    phone = field('Telefono esatto della prenotazione', 'privacy-phone', 'tel');
  phone.input.required = true;
  phone.input.minLength = 5;
  phone.input.maxLength = 50;
  const rows = el('div', { class: 'stack' }),
    more = button('Carica altre prenotazioni', () => search(true), 'secondary');
  more.hidden = true;
  let cursor: string | null = null,
    generation = 0;
  async function search(append = false): Promise<void> {
    if (!phone.input.reportValidity()) return;
    const current = ++generation;
    if (!append) cursor = null;
    const records = await rpc(
      'search_privacy_reservations',
      { p_venue: context.venue?.id ?? null, p_phone: phone.input.value.trim(), p_after: cursor },
      z.array(reservationSchema),
    );
    if (current !== generation) return;
    if (!append) rows.replaceChildren();
    const shown = records.slice(0, 50);
    cursor = shown.at(-1)?.id ?? null;
    more.hidden = records.length <= 50;
    for (const booking of shown) {
      const card = el(
        'article',
        { class: 'card stack' },
        el(
          'div',
          { class: 'row between' },
          el('h2', {}, `${booking.first_name} ${booking.last_name}`),
          status(booking.status),
        ),
        el(
          'p',
          {},
          `${booking.phone} · ${booking.service_date} · ${booking.slot_time.slice(0, 5)}`,
        ),
      );
      if (booking.privacy_hold)
        card.append(
          status('CONSERVAZIONE PROTETTA'),
          el('p', {}, booking.privacy_hold_reason ?? ''),
        );
      if (booking.anonymized_at) card.append(el('p', {}, 'Dati di contatto anonimizzati.'));
      card.append(
        el(
          'div',
          { class: 'row' },
          button('Esporta dati personali', () => exportData(booking), 'secondary'),
          ...(!booking.anonymized_at
            ? [
                button('Rettifica contatti', () => change(booking, 'RECTIFY'), 'secondary'),
                button('Anonimizza', () => change(booking, 'ANONYMIZE'), 'secondary'),
              ]
            : []),
          button(
            booking.privacy_hold ? 'Rimuovi protezione' : 'Proteggi conservazione',
            () => change(booking, booking.privacy_hold ? 'RELEASE_HOLD' : 'HOLD'),
            'secondary',
          ),
        ),
      );
      rows.append(card);
    }
    if (!append && !shown.length)
      rows.append(
        el('p', {}, 'Nessuna prenotazione trovata per questo telefono nella sede selezionata.'),
      );
  }
  function verification(): HTMLInputElement {
    const check = el('input', { type: 'checkbox', required: '' });
    return check;
  }
  async function exportData(booking: Reservation): Promise<void> {
    const check = verification(),
      popup = dialog(
        'Esporta questa prenotazione',
        el(
          'p',
          {},
          'Il file include contatti, note del cliente, allergie e risposte del modulo. Verifica identità del richiedente e destinatario prima di consegnarlo.',
        ),
        el('label', {}, check, 'Ho verificato l’identità e il destinatario della richiesta.'),
      );
    popup.append(
      button('Scarica con verifica password', async () => {
        if (!check.reportValidity()) return;
        const grant = await stepUp('PRIVACY', booking.id),
          data = await rpc(
            'export_reservation_personal_data',
            { p_reservation: booking.id, p_grant: grant },
            z.record(z.string(), z.unknown()),
          );
        const url = URL.createObjectURL(
            new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }),
          ),
          link = el('a', { href: url, download: `Plateform-prenotazione-${booking.id}.json` });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        popup.close();
      }),
    );
  }
  function change(
    booking: Reservation,
    action: 'RECTIFY' | 'ANONYMIZE' | 'HOLD' | 'RELEASE_HOLD',
  ): void {
    const reason = field('Motivo della richiesta', 'privacy-reason');
    reason.input.required = true;
    reason.input.minLength = 8;
    reason.input.maxLength = 1000;
    const check = verification();
    const first = field('Nome', 'first_name', 'text', booking.first_name),
      last = field('Cognome', 'last_name', 'text', booking.last_name),
      contact = field('Telefono', 'phone', 'tel', booking.phone);
    first.input.required = true;
    first.input.maxLength = 100;
    last.input.maxLength = 100;
    contact.input.required = true;
    contact.input.minLength = 5;
    contact.input.maxLength = 50;
    const labels = {
        RECTIFY: 'Rettifica dati di contatto',
        ANONYMIZE: 'Anonimizza prenotazione',
        HOLD: 'Proteggi conservazione',
        RELEASE_HOLD: 'Rimuovi protezione della conservazione',
      },
      key = crypto.randomUUID();
    const popup = dialog(
      labels[action],
      ...(action === 'RECTIFY'
        ? [first.root, last.root, contact.root]
        : [
            el(
              'p',
              {},
              action === 'ANONYMIZE'
                ? 'Saranno rimossi contatti, note, allergie e risposte. Data, stato e coperti resteranno nello storico. Il server consente l’operazione soltanto dopo la conclusione della prenotazione.'
                : action === 'HOLD'
                  ? 'La protezione impedisce l’anonimizzazione automatica e manuale fino alla sua rimozione.'
                  : 'L’anonimizzazione automatica potrà riprendere secondo i tempi configurati.',
            ),
          ]),
      reason.root,
      el('label', {}, check, 'Ho verificato la richiesta e confermo questa operazione.'),
    );
    popup.append(
      button('Conferma con password', async () => {
        if (
          !check.reportValidity() ||
          !reason.input.reportValidity() ||
          (action === 'RECTIFY' &&
            [first, last, contact].some((control) => !control.input.reportValidity()))
        )
          return;
        const grant = await stepUp('PRIVACY', booking.id);
        await rpc(
          'change_reservation_privacy',
          {
            p_reservation: booking.id,
            p_version: booking.version,
            p_action: action,
            p_changes:
              action === 'RECTIFY'
                ? {
                    first_name: first.input.value,
                    last_name: last.input.value,
                    phone: contact.input.value,
                  }
                : {},
            p_reason: reason.input.value,
            p_grant: grant,
            p_key: key,
          },
          z.object({ id: z.uuid(), version: z.number().int() }),
        );
        popup.close();
        toast('Richiesta applicata e registrata.');
        await search();
      }),
    );
  }
  view.append(
    el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Richieste sui dati delle prenotazioni'),
      el(
        'p',
        { class: 'muted' },
        'La ricerca usa un telefono esatto e comprende soltanto le prenotazioni autorizzate nella sede selezionata.',
      ),
      phone.root,
      button('Cerca prenotazioni', () => search()),
      rows,
      more,
    ),
  );
  if (context.profile.scope === 'CHAIN') {
    const config = await rpc(
      'get_privacy_configuration',
      {},
      z
        .object({ version: z.number().int(), retention: z.record(z.string(), z.unknown()) })
        .nullable(),
    );
    if (config) {
      const section = el(
        'section',
        { class: 'card stack' },
        el('h2', {}, 'Tempi di conservazione dell’installazione'),
        el(
          'p',
          {},
          'Imposta i tempi concordati per questo ristorante. Le prenotazioni concluse vengono anonimizzate; contabilità e audit restano conservati. Le identità cliente tecniche vengono disabilitate e pseudonimizzate mantenendo i riferimenti storici.',
        ),
      );
      const labels: Record<string, string> = {
        reservation_days: 'Prenotazioni concluse, giorni',
        customer_session_days: 'Sessioni cliente scadute, giorni',
        telemetry_days: 'Telemetry, giorni',
        error_days: 'Errori tecnici, giorni',
        signal_days: 'Segnali Realtime, giorni',
      };
      const controls = Object.entries(labels).map(([key, label]) => {
        const control = field(
          label,
          key,
          'number',
          String(
            config.retention[key] ??
              (key === 'reservation_days' ? 180 : key === 'signal_days' ? 1 : 30),
          ),
        );
        control.input.required = true;
        control.input.min = '1';
        control.input.max = '3650';
        control.input.step = '1';
        section.append(control.root);
        return { key, ...control };
      });
      const enabled = el('input', { type: 'checkbox' });
      enabled.checked = config.retention.enabled === true;
      const confirmation = verification(),
        key = crypto.randomUUID();
      section.append(
        el('label', {}, enabled, 'Abilita le procedure automatiche di conservazione'),
        el(
          'label',
          {},
          confirmation,
          'Confermo che questi tempi sono stati concordati per l’installazione.',
        ),
        button('Salva conservazione con password', async () => {
          if (
            !confirmation.reportValidity() ||
            controls.some((control) => !control.input.reportValidity())
          )
            return;
          const grant = await stepUp('PRIVACY');
          await rpc(
            'configure_data_retention',
            {
              p_version: config.version,
              p_settings: {
                ...Object.fromEntries(
                  controls.map((control) => [control.key, Number(control.input.value)]),
                ),
                enabled: enabled.checked,
              },
              p_grant: grant,
              p_key: key,
            },
            z.object({ version: z.number().int() }),
          );
          toast('Tempi di conservazione aggiornati.');
          await context.refresh?.();
        }),
      );
      view.append(section);
    }
  }
  return view;
}
