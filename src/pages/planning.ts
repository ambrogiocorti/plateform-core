import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import type { StaffContext } from './staff-context';
const record = z.record(z.string(), z.unknown());
export async function planningPage(context: StaffContext): Promise<HTMLElement> {
  const [staff, shifts, services, rules, forms, fields, slots] = await Promise.all([
    readRows(
      'staff_profiles',
      z.object({ id: z.uuid(), display_name: z.string(), active: z.boolean() }),
    ),
    readRows('shifts', record, context.venue?.id),
    readRows('services', record, context.venue?.id),
    readRows('service_booking_rules', record, context.venue?.id),
    readRows('reservation_form_definitions', record, context.venue?.id, { active: 'true' }),
    readRows('reservation_form_fields', record, context.venue?.id),
    readRows('booking_time_slots', record, context.venue?.id),
  ]);
  const view = el('div', { class: 'stack' });
  const shiftSection = el(
    'section',
    { class: 'card stack' },
    el('h2', {}, 'Pianificazione turni'),
    el('p', {}, `Orari della sede: ${context.venue?.timezone ?? 'Europe/Rome'}`),
  );
  function shiftEditor(row?: Record<string, unknown>): void {
    const select = el(
      'select',
      { 'aria-label': 'Dipendente' },
      ...staff.filter((s) => s.active).map((s) => el('option', { value: s.id }, s.display_name)),
    );
    select.value = String(row?.staff_id ?? staff[0]?.id ?? '');
    function local(value: unknown): string {
      if (typeof value !== 'string') return '';
      const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: context.venue?.timezone ?? 'Europe/Rome',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(value));
      return parts.replace(' ', 'T');
    }
    const start = field('Inizio', 'start', 'datetime-local', local(row?.starts_at)),
      end = field('Fine', 'end', 'datetime-local', local(row?.ends_at));
    start.input.required = true;
    end.input.required = true;
    const key = crypto.randomUUID(),
      popup = dialog('Turno', el('label', {}, 'Dipendente', select), start.root, end.root);
    popup.append(
      button('Salva turno', async () => {
        if (!start.input.reportValidity() || !end.input.reportValidity()) return;
        await rpc(
          'save_shift_local',
          {
            p_venue: context.venue?.id,
            p_id: row?.id ?? null,
            p_staff: select.value,
            p_start: start.input.value,
            p_end: end.input.value,
            p_version: row?.version ?? null,
            p_key: key,
          },
          record,
        );
        popup.close();
        toast('Turno salvato.');
        await context.refresh?.();
      }),
    );
  }
  shiftSection.append(button('Aggiungi turno', () => shiftEditor()));
  for (const row of shifts.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))) {
    const name = staff.find((s) => s.id === row.staff_id)?.display_name ?? 'Dipendente';
    const format = (value: unknown) =>
      new Date(String(value)).toLocaleString('it-IT', {
        timeZone: context.venue?.timezone ?? 'Europe/Rome',
        dateStyle: 'short',
        timeStyle: 'short',
      });
    shiftSection.append(
      el(
        'div',
        { class: 'configuration-row' },
        el('p', {}, `${name} · ${format(row.starts_at)} – ${format(row.ends_at)}`),
        button('Modifica', () => shiftEditor(row), 'secondary'),
      ),
    );
  }
  const booking = el(
    'section',
    { class: 'card stack' },
    el('h2', {}, 'Capacità e fasce prenotabili'),
  );
  for (const service of services) {
    const current = rules.find((r) => r.service_id === service.id);
    booking.append(
      el(
        'div',
        { class: 'configuration-row' },
        el('strong', {}, String(service.name)),
        button(
          'Configura capacità',
          () => {
            const definitions = [
              ['p_service_covers', 'Coperti servizio', 'max_covers_service', 120],
              ['p_interval', 'Minuti tra gli arrivi', 'slot_interval_minutes', 30],
              ['p_arrivals', 'Gruppi per fascia', 'max_arrivals_per_slot', 10],
              ['p_slot_covers', 'Coperti per fascia', 'max_covers_per_slot', 20],
              [
                'p_auto_party',
                'Gruppo massimo confermato automaticamente',
                'max_party_size_auto_confirm',
                8,
              ],
            ] as const;
            const inputs = definitions.map(([key, label, source, value]) => ({
              key,
              ...field(label, key, 'number', String(current?.[source] ?? value)),
            }));
            inputs.forEach((f) => {
              f.input.required = true;
              f.input.min = '1';
              f.input.max = '10000';
            });
            const large = el(
              'select',
              { 'aria-label': 'Grandi gruppi' },
              el('option', { value: 'REQUESTED' }, 'Richiedi approvazione Host'),
              el('option', { value: 'REJECT' }, 'Invita a contattare il ristorante'),
            );
            large.value = String(current?.large_party_mode ?? 'REQUESTED');
            const popup = dialog(
              `Capacità · ${String(service.name)}`,
              ...inputs.map((f) => f.root),
              large,
            );
            popup.append(
              button('Salva capacità', async () => {
                if (inputs.some((f) => !f.input.reportValidity())) return;
                await rpc(
                  'configure_booking_rules',
                  {
                    p_venue: context.venue?.id,
                    p_service: service.id,
                    ...Object.fromEntries(inputs.map((f) => [f.key, Number(f.input.value)])),
                    p_large_party: large.value,
                  },
                  z.null(),
                );
                popup.close();
                await context.refresh?.();
              }),
            );
          },
          'secondary',
        ),
        button(
          'Blocca o modifica una fascia',
          () => {
            const date = field('Data', 'date', 'date'),
              time = field('Ora; vuoto = intero servizio', 'time', 'time'),
              covers = field('Limite coperti; vuoto = regola generale', 'covers', 'number'),
              arrivals = field('Limite gruppi; vuoto = regola generale', 'arrivals', 'number'),
              reason = field('Motivo', 'reason');
            date.input.required = true;
            reason.input.required = true;
            reason.input.minLength = 3;
            covers.input.min = '0';
            arrivals.input.min = '0';
            const closed = el('input', { type: 'checkbox' });
            const key = crypto.randomUUID(),
              popup = dialog(
                'Gestione fascia',
                date.root,
                time.root,
                covers.root,
                arrivals.root,
                el('label', {}, closed, 'Chiusa alle prenotazioni'),
                reason.root,
              );
            popup.append(
              button('Salva fascia', async () => {
                if ([...popup.querySelectorAll('input')].some((i) => !i.reportValidity())) return;
                await rpc(
                  'save_booking_slot',
                  {
                    p_venue: context.venue?.id,
                    p_service: service.id,
                    p_date: date.input.value,
                    p_time: time.input.value || null,
                    p_closed: closed.checked,
                    p_covers: covers.input.value ? Number(covers.input.value) : null,
                    p_arrivals: arrivals.input.value ? Number(arrivals.input.value) : null,
                    p_reason: reason.input.value,
                    p_key: key,
                  },
                  z.object({ id: z.uuid() }),
                );
                popup.close();
                await context.refresh?.();
              }),
            );
          },
          'secondary',
        ),
      ),
    );
  }
  for (const slot of slots)
    booking.append(
      el(
        'p',
        {},
        `${services.find((s) => s.id === slot.service_id)?.name ?? 'Servizio'} · ${String(slot.service_date)} ${String(slot.slot_time ?? 'Intero servizio')} · ${slot.closed ? 'CHIUSO' : `Coperti ${slot.max_covers_override ?? 'standard'}, gruppi ${slot.max_arrivals_override ?? 'standard'}`} · ${String(slot.reason ?? '')}`,
      ),
    );
  // The server owns licensing, provider availability and every deposit rule. The UI only
  // submits a versioned configuration command; no client-side decision can require payment.
  const depositSection = el(
    'section',
    { class: 'card stack', 'aria-label': 'Caparra per gruppi numerosi' },
    el('h2', {}, 'Caparra per gruppi numerosi'),
  );
  const depositSettings = await rpc(
    'get_large_group_deposit_settings',
    { p_venue: context.venue?.id },
    z.object({
      licensed: z.boolean(),
      providers: z.array(z.string()),
      services: z.array(
        z.object({
          service_id: z.uuid(),
          name: z.string(),
          version: z.number(),
          enabled: z.boolean(),
          min_party_size: z.number().nullable(),
          amount_cents: z.number().nullable(),
          cancel_refund_hours: z.number(),
          max_party_size_auto_confirm: z.number(),
        }),
      ),
    }),
  ).catch(() => null);
  if (!depositSettings) {
    depositSection.append(
      el('p', { role: 'status' }, 'La configurazione delle caparre non è disponibile sul server.'),
    );
  } else {
    const providers = depositSettings.providers.map((provider) =>
      provider === 'STRIPE' ? 'Stripe' : 'Satispay',
    );
    depositSection.append(
      el(
        'p',
        { class: 'muted' },
        providers.length
          ? `Pagamento con ${providers.join(' e ')}.`
          : 'Nessun provider per le caparre è abilitato in questa sede.',
      ),
    );
    if (!depositSettings.licensed)
      depositSection.append(
        el('p', { role: 'status' }, 'La licenza per le caparre online non è attiva.'),
      );
    for (const service of depositSettings.services) {
      const enabled = el('input', { type: 'checkbox' });
      enabled.checked = service.enabled;
      enabled.disabled = !depositSettings.licensed || !depositSettings.providers.length;
      const threshold = field(
        'Da quante persone si chiede la caparra',
        'deposit_min_party_size',
        'number',
        String(service.min_party_size ?? 6),
      );
      threshold.input.min = '2';
      threshold.input.max = String(service.max_party_size_auto_confirm);
      threshold.input.required = true;
      const amount = field(
        'Importo della caparra in euro',
        'deposit_amount_eur',
        'number',
        String((service.amount_cents ?? 2500) / 100),
      );
      amount.input.min = '1';
      amount.input.max = '1000';
      amount.input.step = '0.01';
      amount.input.required = true;
      const refundHours = field(
        'Ore prima della visita per il rimborso automatico',
        'deposit_refund_hours',
        'number',
        String(service.cancel_refund_hours),
      );
      refundHours.input.min = '0';
      refundHours.input.max = '720';
      refundHours.input.required = true;
      const summary = el('p', { role: 'status' });
      const renderSummary = (active: boolean, euro: number, people: number) => {
        const total = euro.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
        summary.textContent = active
          ? `Attiva: ${total} da ${people} persone.`
          : 'Caparra non richiesta per questo servizio.';
      };
      renderSummary(
        service.enabled,
        (service.amount_cents ?? 0) / 100,
        service.min_party_size ?? 0,
      );
      const save = button('Salva caparra · ' + service.name, async () => {
        if (
          !threshold.input.reportValidity() ||
          !amount.input.reportValidity() ||
          !refundHours.input.reportValidity()
        )
          return;
        const value = Number(amount.input.value);
        const result = await rpc(
          'configure_large_group_deposit',
          {
            p_venue: context.venue?.id,
            p_service: service.service_id,
            p_version: service.version,
            p_enabled: enabled.checked,
            p_min_party_size: Number(threshold.input.value),
            p_amount_cents: Math.round(value * 100),
            p_cancel_refund_hours: Number(refundHours.input.value),
            p_key: crypto.randomUUID(),
          },
          z.object({
            version: z.number(),
            enabled: z.boolean(),
            min_party_size: z.number().nullable(),
            amount_cents: z.number().nullable(),
          }),
        );
        service.version = result.version;
        renderSummary(
          result.enabled,
          (result.amount_cents ?? 0) / 100,
          result.min_party_size ?? 0,
        );
        toast('Caparra aggiornata.');
        await context.refresh?.();
      });
      if (!depositSettings.licensed || !depositSettings.providers.length) save.disabled = true;
      depositSection.append(
        el(
          'div',
          { class: 'card stack' },
          el('h3', {}, service.name),
          el('label', {}, enabled, 'Chiedi la caparra ai gruppi numerosi'),
          threshold.root,
          amount.root,
          refundHours.root,
          summary,
          save,
        ),
      );
    }
  }

  const form = forms[0];
  const formSection = el(
    'section',
    { class: 'card stack' },
    el('h2', {}, 'Modulo di prenotazione'),
    button('Modifica campi del modulo', () => {
      const name = field('Nome modulo', 'name', 'text', String(form?.name ?? 'Prenotazione'));
      name.input.required = true;
      const list = el('div', { class: 'stack' });
      const editors: {
        id: string;
        root: HTMLElement;
        key: HTMLInputElement;
        label: HTMLInputElement;
        type: HTMLSelectElement;
        placeholder: HTMLInputElement;
        options: HTMLTextAreaElement;
        required: HTMLInputElement;
        visible: HTMLInputElement;
      }[] = [];
      function add(row?: Record<string, unknown>): void {
        const key = field(
            'Codice campo',
            'key',
            'text',
            String(row?.key ?? `campo_${editors.length + 1}`),
          ),
          label = field('Etichetta', 'label', 'text', String(row?.label ?? '')),
          placeholder = field('Segnaposto', 'placeholder', 'text', String(row?.placeholder ?? ''));
        key.input.pattern = '[a-z][a-z0-9_]{0,49}';
        key.input.required = true;
        label.input.required = true;
        const type = el(
          'select',
          { 'aria-label': 'Tipo campo' },
          ...[
            'text',
            'textarea',
            'number',
            'tel',
            'date',
            'time',
            'select',
            'radio',
            'checkbox',
          ].map((t) => el('option', { value: t }, t)),
        );
        type.value = String(row?.type ?? 'text');
        const options = el('textarea', { 'aria-label': 'Opzioni, una per riga' });
        options.value = Array.isArray(row?.options) ? row.options.map(String).join('\n') : '';
        const required = el('input', { type: 'checkbox' }),
          visible = el('input', { type: 'checkbox' });
        required.checked = row?.required === true;
        visible.checked = row?.visible !== false;
        const entry = {
          id: String(row?.id ?? crypto.randomUUID()),
          root: el(
            'section',
            { class: 'card stack' },
            key.root,
            label.root,
            placeholder.root,
            type,
            el('label', {}, 'Opzioni, una per riga', options),
            el('label', {}, required, 'Obbligatorio'),
            el('label', {}, visible, 'Visibile'),
          ),
          key: key.input,
          label: label.input,
          type,
          placeholder: placeholder.input,
          options,
          required,
          visible,
        };
        entry.root.append(
          button(
            'Sposta sopra',
            () => {
              const i = editors.indexOf(entry);
              if (i > 0) {
                editors.splice(i, 1);
                editors.splice(i - 1, 0, entry);
                list.replaceChildren(...editors.map((e) => e.root));
              }
            },
            'quiet',
          ),
          button(
            'Rimuovi campo',
            () => {
              editors.splice(editors.indexOf(entry), 1);
              entry.root.remove();
            },
            'quiet',
          ),
        );
        editors.push(entry);
        list.append(entry.root);
      }
      for (const f of fields
        .filter((f) => f.form_id === form?.id)
        .sort((a, b) => Number(a.sort_order) - Number(b.sort_order)))
        add(f);
      const popup = dialog(
        'Modulo di prenotazione',
        el(
          'p',
          {},
          'I campi standard nome, telefono, persone, data e ora sono sempre gestiti dal modulo principale.',
        ),
        name.root,
        el(
          'div',
          { class: 'row' },
          button('Aggiungi campo', () => add(), 'secondary'),
          button(
            'Aggiungi note',
            () => add({ key: 'note', label: 'Note', type: 'textarea', visible: true }),
            'quiet',
          ),
          button(
            'Aggiungi allergie',
            () => add({ key: 'allergies', label: 'Allergie', type: 'textarea', visible: true }),
            'quiet',
          ),
          button(
            'Aggiungi occasione speciale',
            () =>
              add({
                key: 'special_occasion',
                label: 'Occasione speciale',
                type: 'select',
                options: ['Compleanno', 'Anniversario', 'Altro'],
                visible: true,
              }),
            'quiet',
          ),
        ),
        list,
      );
      const key = crypto.randomUUID();
      popup.append(
        button('Salva modulo', async () => {
          if ([...popup.querySelectorAll('input')].some((i) => !i.reportValidity())) return;
          await rpc(
            'save_reservation_form',
            {
              p_venue: context.venue?.id,
              p_id: form?.id ?? null,
              p_version: form?.version ?? null,
              p_name: name.input.value,
              p_fields: editors.map((e, index) => ({
                id: e.id,
                key: e.key.value,
                type: e.type.value,
                label: e.label.value,
                placeholder: e.placeholder.value,
                required: e.required.checked,
                visible: e.visible.checked,
                sort_order: index,
                options: e.options.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })),
              p_key: key,
            },
            record,
          );
          popup.close();
          toast('Modulo salvato.');
          await context.refresh?.();
        }),
      );
    }),
  );
  view.append(shiftSection, booking, depositSection, formSection);
  return view;
}
