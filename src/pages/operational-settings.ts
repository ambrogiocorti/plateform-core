import { z } from 'zod';
import { client, readRows, rpc, safeError } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import type { StaffContext } from './staff-context';
import { floorStatusLabels } from '../components/floor-view';
import { notificationRulesSchema } from '../components/notification-indicator';
import { enableNotificationSound, playNotificationSound } from '../services/notification-sound';
import { permittedPaymentMethods, permittedPrintDriver, permittedPrintDrivers } from '../services/commercial-scope';

const record = z.record(z.string(), z.unknown());
const methods = permittedPaymentMethods(['CASH', 'CARD_POS', 'STRIPE', 'SATISPAY_POS', 'SATISPAY_API']);
const methodNames: Record<string, string> = {
  CASH: 'Contanti',
  CARD_POS: 'POS esterno',
  STRIPE: 'Stripe',
  SATISPAY_POS: 'Satispay su POS',
  SATISPAY_API: 'Satispay online',
};
export function checkboxGroup(
  title: string,
  values: readonly string[],
  selected: string[],
  labels: Record<string, string> = {},
) {
  const controls = values.map((value) => {
    const input = el('input', { type: 'checkbox', value });
    input.checked = selected.includes(value);
    return { value, input };
  });
  return {
    root: el(
      'fieldset',
      {},
      el('legend', {}, title),
      ...controls.map((control) =>
        el(
          'label',
          { class: 'checkbox-line' },
          control.input,
          labels[control.value] ?? control.value,
        ),
      ),
    ),
    values: () =>
      controls.filter((control) => control.input.checked).map((control) => control.value),
  };
}
const select = (name: string, values: readonly string[], current: unknown) => {
  const input = el(
    'select',
    { 'aria-label': name },
    ...values.map((value) => el('option', { value }, value.replaceAll('_', ' '))),
  );
  input.value = String(current);
  return input;
};

export async function operationalSettingsPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venue) return el('p', {}, 'Seleziona una sede autorizzata.');
  const { data, error } = await client()
    .from('venue_settings')
    .select('*')
    .eq('venue_id', context.venue.id)
    .single();
  if (error) throw safeError(error);
  const settings = record.parse(data),
    view = el('div', { class: 'stack' });
  const workflow = el('section', { class: 'card stack' }, el('h2', {}, 'Servizio e clienti'));
  const switches = ['reservations_enabled', 'customer_bill_request', 'returns_enabled'].map(
    (key) => {
      const input = el('input', { type: 'checkbox' });
      input.checked = settings[key] === true;
      return { key, input };
    },
  );
  const names: Record<string, string> = {
    reservations_enabled: 'Prenotazioni online',
    customer_bill_request: 'Il cliente può richiedere il conto',
    returns_enabled: 'Gestione piatti tornati indietro',
  };
  workflow.append(
    ...switches.map((entry) =>
      el('label', { class: 'checkbox-line' }, entry.input, names[entry.key]),
    ),
  );
  const ordering = select(
    'Ordinazione cliente',
    ['DISABLED', 'WAITER_APPROVAL', 'DIRECT'],
    settings.customer_ordering,
  );
  const stepRoles = checkboxGroup(
    'Chi avvia lo step successivo',
    ['WAITER', 'PASS', 'KITCHEN_ADMIN'],
    z.array(z.string()).parse(settings.step_starter_roles),
  );
  const routing = checkboxGroup(
    'Destinatari piatti pronti',
    ['TABLE', 'ZONE', 'RUNNER'],
    z.array(z.string()).parse(settings.delivery_routing),
  );
  workflow.append(el('label', {}, 'Ordinazione cliente', ordering), stepRoles.root, routing.root);
  const key = crypto.randomUUID();
  workflow.append(
    button('Salva flussi operativi', async () => {
      await rpc(
        'save_operational_settings',
        {
          p_venue: context.venue?.id,
          p_version: settings.version,
          p_key: key,
          p_values: {
            ...Object.fromEntries(switches.map((entry) => [entry.key, entry.input.checked])),
            customer_ordering: ordering.value,
            step_starter_roles: stepRoles.values(),
            delivery_routing: routing.values(),
          },
        },
        record,
      );
      toast('Flussi aggiornati.');
      await context.refresh?.();
    }),
  );
  const financial = el('section', { class: 'card stack' }, el('h2', {}, 'Pagamenti e riduzioni'));
  const pay = checkboxGroup(
    'Metodi attivi nella sede',
    methods,
    z.array(z.string()).parse(settings.payment_methods),
    methodNames,
  );
  const policies = ['DISABLED', 'ADMIN_APPROVAL_REQUIRED', 'CASHIER_AUTONOMOUS'];
  const discount = select('Sconti', policies, settings.discount_policy),
    gift = select('Omaggi', policies, settings.complimentary_policy);
  const financeKey = crypto.randomUUID();
  financial.append(
    el('p', { class: 'muted' }, 'Edizione CORE: incassi in contanti o POS carta esterno, senza collegamento al provider. Verifica l’esito sul terminale prima di confermare.'),
    pay.root,
    el('label', {}, 'Sconti', discount),
    el('label', {}, 'Omaggi', gift),
    button('Salva regole finanziarie', async () => {
      await rpc(
        'save_financial_settings',
        {
          p_venue: context.venue?.id,
          p_version: settings.version,
          p_methods: pay.values(),
          p_discount: discount.value,
          p_complimentary: gift.value,
          p_key: financeKey,
        },
        record,
      );
      toast('Regole aggiornate.');
      await context.refresh?.();
    }),
  );
  const venue = el('section', { class: 'card stack' }, el('h2', {}, 'Contatti e orari della sede'));
  const venueRows = await readRows('venues', record, undefined, { id: context.venue.id }),
    row = venueRows[0];
  if (row) {
    const fields = [
      ['name', 'Nome'],
      ['address', 'Indirizzo'],
      ['phone', 'Telefono'],
      ['email', 'Email'],
    ].map(([key, label]) => ({
      key: key!,
      ...field(label!, key!, key === 'email' ? 'email' : 'text', String(row[key!] ?? '')),
    }));
    const hours = el('textarea', {
      'aria-label': 'Orari di apertura: un giorno e un orario per riga',
      rows: '7',
    });
    const existing = z.record(z.string(), z.unknown()).parse(row.opening_hours);
    hours.value = Object.entries(existing)
      .map(([day, value]) => `${day}: ${String(value)}`)
      .join('\n');
    const venueKey = crypto.randomUUID();
    venue.append(
      ...fields.map((entry) => entry.root),
      el('label', {}, 'Orari, per esempio lunedì: 19:00–23:00', hours),
      button('Salva dati sede', async () => {
        if (fields.some((entry) => !entry.input.reportValidity())) return;
        const opening: Record<string, string> = {};
        for (const line of hours.value.split('\n').filter((line) => line.trim())) {
          const separator = line.indexOf(':');
          if (separator < 1) {
            toast('Scrivi giorno: orario su ogni riga.', true);
            return;
          }
          opening[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
        }
        await rpc(
          'save_venue_details',
          {
            p_venue: context.venue?.id,
            p_version: row.version,
            p_values: {
              ...Object.fromEntries(fields.map((entry) => [entry.key, entry.input.value || null])),
              opening_hours: opening,
            },
            p_key: venueKey,
          },
          record,
        );
        toast('Dati della sede aggiornati.');
        await context.refresh?.();
      }),
    );
  }
  view.append(workflow, financial, venue);
  const registers = await readRows('cash_registers', record, context.venue.id);
  const printers = (
    await readRows(
    'print_devices',
    z.object({
      id: z.uuid(),
      name: z.string(),
      driver: z.enum(['BROWSER', 'EPOS', 'BRIDGE']),
      configuration: z.record(z.string(), z.unknown()).default({}),
    }),
    context.venue.id,
    { active: 'true' },
    )
  ).filter((device) => device.configuration.output !== 'PDF' && permittedPrintDriver(device.driver));
  const stations = await readRows('stations', record, context.venue.id, { active: 'true' });
  const printConfig = el('section', { class: 'card stack' },
    el('h2', {}, 'Postazioni e stampa'),
    el('p', { class: 'muted' }, 'Edizione CORE: stampa via browser/PDF. Driver Epson e bridge non inclusi.'));
  for (const register of registers)
    printConfig.append(
      button(
        `Configura ${String(register.name)}`,
        () => {
          const methodsControl = checkboxGroup(
            'Metodi consentiti sulla cassa',
            methods,
            z.array(z.string()).parse(register.payment_methods),
            methodNames,
          );
          const printer = el(
            'select',
            { 'aria-label': 'Stampante ricevute' },
            el('option', { value: '' }, 'Nessuna stampante'),
            ...printers.map((device) => el('option', { value: device.id }, device.name)),
          );
          printer.value = String(register.printer_id ?? '');
          const popup = dialog(
              'Configurazione cassa',
              methodsControl.root,
              el('label', {}, 'Stampante ricevute', printer),
            ),
            key = crypto.randomUUID();
          popup.append(
            button('Salva cassa', async () => {
              await rpc(
                'save_register_finance',
                {
                  p_register: register.id,
                  p_version: register.version,
                  p_methods: methodsControl.values(),
                  p_printer: printer.value || null,
                  p_key: key,
                },
                record,
              );
              popup.close();
              await context.refresh?.();
            }),
          );
        },
        'secondary',
      ),
    );
  for (const station of stations)
    printConfig.append(
      button(
        `Stampante · ${String(station.name)}`,
        () => {
          const printer = el(
            'select',
            { 'aria-label': 'Stampante stazione' },
            el('option', { value: '' }, 'Nessuna stampante'),
            ...printers.map((device) => el('option', { value: device.id }, device.name)),
          );
          printer.value = String(station.printer_id ?? '');
          const automatic = el('input', { type: 'checkbox' });
          automatic.checked = station.auto_print === true;
          const popup = dialog(
            'Stampa comande',
            el('label', {}, 'Stampante', printer),
            el('label', {}, automatic, 'Accoda automaticamente le nuove comande'),
          );
          popup.append(
            button('Salva stazione', async () => {
              await rpc(
                'configure_station_printer',
                {
                  p_station: station.id,
                  p_printer: printer.value || null,
                  p_auto: automatic.checked,
                  p_version: station.version,
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
    );
  printConfig.append(await printerConfiguration(context));
  view.append(
    printConfig,
    await tableLabelSettings(context),
    notificationSettings(context, settings),
  );
  return view;
}

async function printerConfiguration(context: StaffContext): Promise<HTMLElement> {
  const schema = z.object({
    id: z.uuid(),
    name: z.string(),
    driver: z.enum(['BROWSER', 'EPOS', 'BRIDGE']),
    endpoint: z.string().nullable(),
    active: z.boolean(),
    allowed_roles: z.array(z.string()),
    configuration: z.record(z.string(), z.unknown()).default({}),
    version: z.number().int(),
  });
  const devices = await readRows('print_devices', schema, context.venue!.id),
    section = el('section', { class: 'stack' }, el('h3', {}, 'Stampanti della sede'));
  function edit(existing?: z.infer<typeof schema>): void {
    if (existing && !permittedPrintDriver(existing.driver)) {
      toast('Il driver Epson/bridge non è incluso in questa edizione.', true);
      return;
    }
    const name = field('Nome stampante', 'printer_name', 'text', existing?.name ?? ''),
      endpoint = field(
        'Indirizzo HTTPS della stampante o del bridge',
        'endpoint',
        'url',
        existing?.endpoint ?? '',
      );
    name.input.required = true;
    name.input.maxLength = 160;
    const driver = select(
      'Collegamento stampante',
      permittedPrintDrivers(),
      existing?.driver ?? 'BROWSER',
    );
    const roles = checkboxGroup(
      'Ruoli autorizzati alla stampa',
      ['CASHIER', 'WAITER', 'KITCHEN_ADMIN', 'KITCHEN_STAFF', 'PASS'],
      existing?.allowed_roles ?? ['CASHIER'],
      {
        CASHIER: 'Cassa',
        WAITER: 'Sala',
        KITCHEN_ADMIN: 'Responsabile cucina',
        KITCHEN_STAFF: 'Cucina',
        PASS: 'Pass',
      },
    );
    const active = el('input', { type: 'checkbox' });
    active.checked = existing?.active ?? true;
    const popup = dialog(
      existing ? `Configura ${existing.name}` : 'Nuova stampante',
      name.root,
      el('label', {}, 'Collegamento', driver),
      endpoint.root,
      el(
        'p',
        { class: 'muted' },
        'Questa edizione include soltanto la stampa tramite browser e PDF.',
      ),
      roles.root,
      el('label', {}, active, 'Stampante attiva'),
    );
    const update = () => {
      endpoint.root.hidden = driver.value === 'BROWSER';
      endpoint.input.required = driver.value !== 'BROWSER';
    };
    driver.addEventListener('change', update);
    update();
    const key = crypto.randomUUID();
    popup.append(
      button('Salva stampante', async () => {
        if (
          !name.input.reportValidity() ||
          (driver.value !== 'BROWSER' && !endpoint.input.reportValidity())
        )
          return;
        if (!roles.values().length) {
          toast('Abilita almeno un ruolo operativo.', true);
          return;
        }
        await rpc(
          'save_print_device',
          {
            p_id: existing?.id ?? null,
            p_venue: context.venue?.id,
            p_version: existing?.version ?? null,
            p_name: name.input.value,
            p_driver: driver.value,
            p_endpoint: driver.value === 'BROWSER' ? null : endpoint.input.value,
            p_roles: roles.values(),
            p_active: active.checked,
            p_key: key,
          },
          z.object({ id: z.uuid(), version: z.number().int() }),
        );
        popup.close();
        toast('Stampante configurata.');
        await context.refresh?.();
      }),
    );
  }
  section.append(button('Aggiungi stampante', () => edit(), 'secondary'));
  for (const device of devices) {
    const managedPdf = device.configuration.output === 'PDF';
    section.append(
      el(
        'div',
        { class: 'row between' },
        el(
          'span',
          {},
          managedPdf
            ? `${device.name} · uscita PDF integrata · ${device.active ? 'Attiva' : 'Archiviata'}`
            : `${device.name} · ${device.driver} · ${device.active ? 'Attiva' : 'Archiviata'}`,
        ),
        managedPdf
          ? el('span', { class: 'muted' }, 'Gestita da Plateform')
          : permittedPrintDriver(device.driver)
            ? button('Configura stampante', () => edit(device), 'secondary')
            : el('span', { class: 'muted' }, 'Driver non incluso in questa edizione'),
      ),
    );
  }
  return section;
}

async function tableLabelSettings(context: StaffContext): Promise<HTMLElement> {
  const labels = await readRows(
    'table_status_definitions',
    z.object({
      technical_status: z.string(),
      label: z.string(),
      color: z.string(),
      icon: z.string().nullable(),
      sort_order: z.number().int(),
    }),
    context.venue!.id,
  );
  const section = el(
    'section',
    { class: 'card stack' },
    el('h2', {}, 'Etichette degli stati del tavolo'),
    el(
      'p',
      { class: 'muted' },
      'Nome, colore e simbolo cambiano la rappresentazione. Le regole operative di ogni stato restano applicate dal server.',
    ),
  );
  for (const [index, [state, label]] of Object.entries(floorStatusLabels).entries()) {
    const current = labels.find((row) => row.technical_status === state);
    section.append(
      button(
        `${label} → ${current?.label ?? label}`,
        () => {
          const name = field('Etichetta', 'label', 'text', current?.label ?? label),
            color = field('Colore', 'color', 'color', current?.color ?? '#B88A55'),
            icon = field('Simbolo breve', 'icon', 'text', current?.icon ?? '');
          name.input.required = true;
          name.input.maxLength = 80;
          icon.input.maxLength = 30;
          const popup = dialog('Aspetto dello stato', name.root, color.root, icon.root),
            key = crypto.randomUUID();
          popup.append(
            button('Salva etichetta', async () => {
              if (!name.input.reportValidity()) return;
              await rpc(
                'configure_table_label',
                {
                  p_venue: context.venue?.id,
                  p_status: state,
                  p_label: name.input.value,
                  p_color: color.input.value,
                  p_icon: icon.input.value || null,
                  p_order: current?.sort_order ?? index,
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
    );
  }
  return section;
}

function notificationSettings(
  context: StaffContext,
  settings: Record<string, unknown>,
): HTMLElement {
  const rules = notificationRulesSchema.parse(settings.sounds),
    section = el('section', { class: 'card stack' }, el('h2', {}, 'Avvisi e notifiche'));
  const categories: Record<string, string> = {
    DEFAULT: 'Altri avvisi',
    RESERVATION: 'Prenotazioni',
    CUSTOMER_CALL: 'Chiamate clienti',
    BILL_REQUEST: 'Richiesta conto',
    NEW_ORDER: 'Nuovo ordine cliente',
    ORDER_APPROVAL: 'Ordine da verificare',
    STEP_PREPARED: 'Piatti preparati',
    STEP_READY: 'Step pronto',
    ORDER_CHANGE: 'Modifica comanda',
    RETURN_APPROVAL: 'Piatti resi',
    DISCOUNT_APPROVAL: 'Sconti e omaggi',
    CASH_RECONCILIATION: 'Differenze di cassa',
  };
  for (const category of Object.keys(rules)) categories[category] ??= category;
  const controls = Object.entries(categories).map(([category, label]) => {
    const current = rules[category] ?? {
      sound: 'GENTLE' as const,
      priority: 'INFO',
      enabled: true,
      badge: true,
    };
    const sound = select(`Suono ${label}`, ['OFF', 'GENTLE', 'DOUBLE', 'URGENT'], current.sound),
      priority = select(
        `Priorità ${label}`,
        ['INFO', 'WARNING', 'DEGRADED', 'INCIDENT', 'CRITICAL'],
        current.priority,
      );
    const enabled = el('input', { type: 'checkbox' }),
      badge = el('input', { type: 'checkbox' });
    enabled.checked = current.enabled;
    badge.checked = current.badge;
    section.append(
      el(
        'fieldset',
        { class: 'stack' },
        el('legend', {}, label),
        el(
          'div',
          { class: 'row' },
          el('label', {}, 'Suono', sound),
          el('label', {}, 'Priorità', priority),
          el('label', {}, enabled, 'Avviso abilitato'),
          el('label', {}, badge, 'Mostra nel badge'),
          button(
            'Prova suono',
            async () => {
              await enableNotificationSound();
              playNotificationSound(
                z.enum(['OFF', 'GENTLE', 'DOUBLE', 'URGENT']).parse(sound.value),
                50,
              );
            },
            'quiet',
          ),
        ),
      ),
    );
    return { category, sound, priority, enabled, badge };
  });
  const key = crypto.randomUUID();
  section.append(
    button('Salva avvisi della sede', async () => {
      const sounds = Object.fromEntries(
        controls.map((c) => [
          c.category,
          {
            sound: c.sound.value,
            priority: c.priority.value,
            enabled: c.enabled.checked,
            badge: c.badge.checked,
          },
        ]),
      );
      await rpc(
        'save_operational_settings',
        {
          p_venue: context.venue?.id,
          p_version: settings.version,
          p_values: { sounds },
          p_key: key,
        },
        record,
      );
      toast('Avvisi aggiornati.');
      await context.refresh?.();
    }),
  );
  return section;
}
