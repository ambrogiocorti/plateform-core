import { z } from 'zod';
import {
  compositionDialog,
  dishScheduleDialog,
  ingredientAllergensDialog,
  venueDishDialog,
} from './catalog';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, emptyState, field, toast } from '../components/dom';
import type { StaffContext } from './staff-context';
import { assetUploadControl } from './branding';

interface ConfigField {
  key: string;
  label: string;
  type?: 'number' | 'time' | 'date' | 'checkbox';
  source?: string;
  optional?: boolean;
  default?: string | number | boolean;
}
interface Module {
  label: string;
  shared?: boolean;
  fields: ConfigField[];
}
const modules: Record<string, Module> = {
  rooms: {
    label: 'Sale',
    fields: [
      { key: 'name', label: 'Nome sala' },
      { key: 'active', label: 'Attiva', type: 'checkbox', default: true },
    ],
  },
  room_layouts: {
    label: 'Layout',
    fields: [
      { key: 'name', label: 'Nome layout' },
      { key: 'room_id', label: 'Sala', source: 'rooms' },
      { key: 'active', label: 'Attivo', type: 'checkbox', default: true },
    ],
  },
  zones: {
    label: 'Zone',
    fields: [
      { key: 'name', label: 'Nome zona' },
      { key: 'room_id', label: 'Sala', source: 'rooms' },
      { key: 'active', label: 'Attiva', type: 'checkbox', default: true },
    ],
  },
  tables: {
    label: 'Tavoli',
    fields: [
      { key: 'name', label: 'Nome tavolo' },
      { key: 'number', label: 'Numero', type: 'number' },
      { key: 'seats', label: 'Coperti', type: 'number' },
      { key: 'room_id', label: 'Sala', source: 'rooms' },
      { key: 'layout_id', label: 'Layout', source: 'room_layouts' },
      { key: 'zone_id', label: 'Zona', source: 'zones', optional: true },
      { key: 'active', label: 'Attivo', type: 'checkbox', default: true },
    ],
  },
  stations: {
    label: 'Stazioni',
    fields: [
      { key: 'name', label: 'Nome stazione' },
      { key: 'active', label: 'Attiva', type: 'checkbox', default: true },
    ],
  },
  services: {
    label: 'Servizi',
    fields: [
      { key: 'name', label: 'Nome servizio' },
      { key: 'starts_at', label: 'Inizio', type: 'time' },
      { key: 'ends_at', label: 'Fine', type: 'time' },
    ],
  },
  categories: {
    label: 'Categorie',
    shared: true,
    fields: [
      { key: 'name', label: 'Nome categoria' },
      { key: 'description', label: 'Descrizione', optional: true },
      { key: 'sort_order', label: 'Ordine', type: 'number' },
      { key: 'active', label: 'Attiva', type: 'checkbox', default: true },
    ],
  },
  ingredients: {
    label: 'Ingredienti',
    shared: true,
    fields: [
      { key: 'name', label: 'Nome ingrediente' },
      { key: 'active', label: 'Attivo', type: 'checkbox', default: true },
    ],
  },
  dietary_tags: {
    label: 'Caratteristiche alimentari',
    shared: true,
    fields: [
      { key: 'code', label: 'Codice' },
      { key: 'label', label: 'Nome visibile' },
    ],
  },
  allergens: {
    label: 'Allergeni',
    shared: true,
    fields: [
      { key: 'name', label: 'Nome allergene' },
      { key: 'code', label: 'Codice' },
    ],
  },
  dishes: {
    label: 'Piatti e bevande',
    shared: true,
    fields: [
      { key: 'name', label: 'Nome' },
      { key: 'description', label: 'Descrizione', optional: true },
      { key: 'category_id', label: 'Categoria', source: 'categories' },
      { key: 'price_cents', label: 'Prezzo in centesimi', type: 'number' },
      { key: 'beverage', label: 'Bevanda', type: 'checkbox' },
      { key: 'active', label: 'Attivo / in catalogo', type: 'checkbox', default: true },
    ],
  },
  cash_registers: {
    label: 'Casse',
    fields: [
      { key: 'name', label: 'Nome cassa' },
      { key: 'code', label: 'Codice' },
      { key: 'location', label: 'Posizione', optional: true },
    ],
  },
};

const recordSchema = z.record(z.string(), z.unknown());
export async function configurationPage(context: StaffContext): Promise<HTMLElement> {
  const visible = Object.entries(modules).filter(
    ([, module]) => !module.shared || context.profile.scope === 'CHAIN' || !context.multiVenue,
  );
  const requested = new URLSearchParams(location.search).get('modulo') ?? 'rooms';
  const module = visible.find(([key]) => key === requested);
  if (!module)
    return emptyState(
      'Configurazione non disponibile',
      'Seleziona un modulo compreso nel tuo ambito di gestione.',
    );
  const [entity, definition] = module;
  const rows = await readRows(
    entity,
    recordSchema,
    definition.shared ? undefined : context.venue?.id,
  );
  const view = el(
    'div',
    { class: 'stack' },
    el(
      'nav',
      { class: 'row', 'aria-label': 'Configurazioni' },
      ...visible.map(([key, value]) =>
        el(
          'a',
          {
            class: 'nav-link',
            href: `${import.meta.env.BASE_URL}gestione?modulo=${key}`,
            ...(key === entity ? { 'aria-current': 'page' } : {}),
          },
          value.label,
        ),
      ),
    ),
    el(
      'div',
      { class: 'row between' },
      el('h2', {}, definition.label),
      button('Aggiungi', async () => editConfiguration(context, entity, definition)),
    ),
  );
  if (!rows.length)
    view.append(
      emptyState(
        `Configura ${definition.label.toLowerCase()}`,
        'Aggiungi il primo elemento per organizzare il servizio.',
      ),
    );
  else
    view.append(
      el(
        'section',
        { class: 'card' },
        ...rows.map((row) =>
          el(
            'div',
            { class: 'configuration-row' },
            el('strong', {}, String(row.name ?? row.code ?? 'Elemento')),
            entity === 'dishes'
              ? button('Ingredienti e varianti', () => compositionDialog(context, row), 'secondary')
              : null,
            entity === 'dishes'
              ? button('Sede e disponibilità', () => venueDishDialog(context, row), 'secondary')
              : null,
            entity === 'dishes'
              ? button(
                  'Disponibilità temporale',
                  () => dishScheduleDialog(context, row),
                  'secondary',
                )
              : null,
            entity === 'ingredients'
              ? button('Allergeni', () => ingredientAllergensDialog(context, row), 'secondary')
              : null,
            button(
              'Modifica',
              async () => editConfiguration(context, entity, definition, row),
              'secondary',
            ),
          ),
        ),
      ),
    );
  return view;
}

async function editConfiguration(
  context: StaffContext,
  entity: string,
  definition: Module,
  existing?: Record<string, unknown>,
): Promise<void> {
  const editor = dialog(`${existing ? 'Modifica' : 'Aggiungi'} · ${definition.label}`);
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  for (const entry of definition.fields) {
    if (entry.source) {
      const shared = modules[entry.source]?.shared;
      const options = await readRows(
        entry.source,
        recordSchema,
        shared ? undefined : context.venue?.id,
      );
      const select = el(
        'select',
        { name: entry.key },
        entry.optional ? el('option', { value: '' }, 'Nessuno') : null,
        ...options.map((row) => el('option', { value: String(row.id) }, String(row.name))),
      );
      if (existing?.[entry.key]) select.value = String(existing[entry.key]);
      editor.append(el('div', { class: 'field' }, el('label', {}, entry.label, select)));
      inputs.set(entry.key, select);
    } else {
      const input = field(
        entry.label,
        entry.key,
        entry.type ?? 'text',
        String(existing?.[entry.key] ?? entry.default ?? (entry.type === 'number' ? '0' : '')),
      );
      input.input.required = !entry.optional && entry.type !== 'checkbox';
      if (entry.type === 'checkbox')
        input.input.checked =
          typeof existing?.[entry.key] === 'boolean'
            ? existing[entry.key] === true
            : entry.default === true;
      editor.append(input.root);
      inputs.set(entry.key, input.input);
    }
  }
  const commandKey = crypto.randomUUID();
  if (entity === 'dishes' && existing?.id && typeof existing.id === 'string') {
    const image = field(
      'Fotografia del piatto',
      'image_path',
      'url',
      String(existing.image_path ?? ''),
    );
    editor.append(
      image.root,
      assetUploadControl('dishes', existing.id, null, (url) => {
        image.input.value = url ?? '';
      }),
    );
    inputs.set('image_path', image.input);
  }
  editor.append(
    button('Salva', async () => {
      const values: Record<string, unknown> = {};
      for (const entry of definition.fields) {
        const input = inputs.get(entry.key);
        if (!input || !input.reportValidity()) return;
        values[entry.key] =
          entry.type === 'checkbox' && input instanceof HTMLInputElement
            ? input.checked
            : entry.type === 'number'
              ? Number(input.value)
              : entry.optional && !input.value
                ? null
                : input.value;
      }
      const image = inputs.get('image_path');
      if (image) {
        if (!image.reportValidity()) return;
        values.image_path = image.value || null;
      }
      await rpc(
        'save_configuration_command',
        {
          p_entity: entity,
          p_key: commandKey,
          p_venue: definition.shared ? null : context.venue?.id,
          p_id: existing?.id ?? null,
          p_values: values,
          p_version: existing?.version ?? null,
        },
        recordSchema,
      );
      editor.close();
      toast('Configurazione salvata.');
      context.navigate(`/gestione?modulo=${entity}`);
    }),
  );
}
