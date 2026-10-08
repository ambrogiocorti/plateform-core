import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import { parseMoney } from '../services/money';
import type { StaffContext } from './staff-context';
const record = z.record(z.string(), z.unknown());
export async function compositionDialog(
  context: StaffContext,
  dish: Record<string, unknown>,
): Promise<void> {
  const id = z.uuid().parse(dish.id);
  const [ingredients, links, tags, tagLinks, groups, options] = await Promise.all([
    readRows('ingredients', record),
    readRows('dish_ingredients', record, undefined, { dish_id: id }),
    readRows('dietary_tags', record),
    readRows('dish_dietary_tags', record, undefined, { dish_id: id }),
    readRows('variant_groups', record, undefined, { dish_id: id, active: 'true' }),
    readRows('variant_options', record, undefined, { active: 'true' }),
  ]);
  const checks = ingredients
    .filter((i) => i.active)
    .map((i) => {
      const link = links.find((l) => l.ingredient_id === i.id);
      const include = el('input', { type: 'checkbox', 'aria-label': `Contiene ${String(i.name)}` });
      const removable = el('input', {
        type: 'checkbox',
        'aria-label': `${String(i.name)} rimovibile`,
      });
      include.checked = !!link;
      removable.checked = link?.removable === true;
      return {
        id: z.uuid().parse(i.id),
        include,
        removable,
        root: el(
          'div',
          { class: 'row' },
          el('label', {}, include, String(i.name)),
          el('label', {}, removable, 'Rimovibile'),
        ),
      };
    });
  const tagChecks = tags.map((t) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = tagLinks.some((l) => l.tag_id === t.id);
    return { id: String(t.id), input, root: el('label', {}, input, String(t.label)) };
  });
  const variants = el('div', { class: 'stack' });
  const groupEditors: {
    id: string;
    root: HTMLElement;
    name: HTMLInputElement;
    required: HTMLInputElement;
    max: HTMLInputElement;
    options: { id: string; input: HTMLInputElement; root: HTMLElement }[];
  }[] = [];
  function addGroup(group?: Record<string, unknown>): void {
    const name = field('Gruppo variante', 'variant-name', 'text', String(group?.name ?? ''));
    const max = field(
      'Massimo opzioni',
      'variant-max',
      'number',
      String(group?.max_selections ?? 1),
    );
    max.input.min = '1';
    max.input.max = '20';
    name.input.required = true;
    name.input.maxLength = 120;
    const required = el('input', { type: 'checkbox' });
    required.checked = group?.required === true;
    const list = el('div', { class: 'stack' });
    const editor = {
      id: String(group?.id ?? crypto.randomUUID()),
      root: el('section', { class: 'card stack' }),
      name: name.input,
      required,
      max: max.input,
      options: [] as { id: string; input: HTMLInputElement; root: HTMLElement }[],
    };
    function addOption(value?: Record<string, unknown>): void {
      const f = field('Opzione', 'option', 'text', String(value?.label ?? ''));
      f.input.required = true;
      f.input.maxLength = 120;
      const option = {
        id: String(value?.id ?? crypto.randomUUID()),
        input: f.input,
        root: el('div', { class: 'row' }, f.root),
      };
      option.root.append(
        button(
          'Rimuovi opzione',
          () => {
            option.root.remove();
            editor.options = editor.options.filter((o) => o !== option);
          },
          'quiet',
        ),
      );
      editor.options.push(option);
      list.append(option.root);
    }
    for (const opt of options.filter((o) => o.group_id === group?.id)) addOption(opt);
    if (!editor.options.length) addOption();
    editor.root.append(
      name.root,
      max.root,
      el('label', {}, required, 'Scelta obbligatoria'),
      list,
      button('Aggiungi opzione', () => addOption(), 'secondary'),
      button(
        'Rimuovi gruppo',
        () => {
          editor.root.remove();
          groupEditors.splice(groupEditors.indexOf(editor), 1);
        },
        'quiet',
      ),
    );
    groupEditors.push(editor);
    variants.append(editor.root);
  }
  groups.forEach(addGroup);
  const popup = dialog(
    `Composizione · ${String(dish.name)}`,
    el('h3', {}, 'Ingredienti'),
    ...checks.map((c) => c.root),
    el('h3', {}, 'Caratteristiche alimentari'),
    ...tagChecks.map((t) => t.root),
    el('h3', {}, 'Varianti'),
    variants,
    button('Aggiungi gruppo', () => addGroup(), 'secondary'),
  );
  const key = crypto.randomUUID();
  popup.append(
    button('Salva composizione', async () => {
      if ([...popup.querySelectorAll('input')].some((i) => !i.reportValidity())) return;
      await rpc(
        'save_dish_composition',
        {
          p_dish: id,
          p_version: dish.version,
          p_ingredients: checks
            .filter((c) => c.include.checked)
            .map((c) => ({ ingredient_id: c.id, removable: c.removable.checked })),
          p_tags: tagChecks.filter((t) => t.input.checked).map((t) => t.id),
          p_variants: groupEditors.map((g) => ({
            id: g.id,
            name: g.name.value,
            required: g.required.checked,
            max_selections: Number(g.max.value),
            options: g.options.map((o) => ({ id: o.id, label: o.input.value })),
          })),
          p_key: key,
        },
        record,
      );
      popup.close();
      toast('Composizione salvata. Gli allergeni derivano dagli ingredienti.');
      await context.refresh?.();
    }),
  );
}
export async function ingredientAllergensDialog(
  context: StaffContext,
  ingredient: Record<string, unknown>,
): Promise<void> {
  const [allergens, links] = await Promise.all([
    readRows('allergens', record),
    readRows('ingredient_allergens', record, undefined, { ingredient_id: String(ingredient.id) }),
  ]);
  const checks = allergens.map((a) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = links.some((l) => l.allergen_id === a.id);
    return { id: a.id, input, root: el('label', {}, input, String(a.name)) };
  });
  const popup = dialog(`Allergeni · ${String(ingredient.name)}`, ...checks.map((c) => c.root));
  popup.append(
    button('Conferma allergeni', async () => {
      await rpc(
        'configure_ingredient_allergens',
        {
          p_ingredient: ingredient.id,
          p_allergens: checks.filter((c) => c.input.checked).map((c) => c.id),
        },
        z.null(),
      );
      popup.close();
      await context.refresh?.();
    }),
  );
}

export async function dishScheduleDialog(
  context: StaffContext,
  dish: Record<string, unknown>,
): Promise<void> {
  const id = z.uuid().parse(dish.id);
  const mode = el(
    'select',
    { 'aria-label': 'Modalità disponibilità temporale' },
    el('option', { value: 'ALWAYS' }, 'Sempre disponibile'),
    el('option', { value: 'DATE' }, 'Solo in una data'),
    el('option', { value: 'WEEKDAYS' }, 'Solo in alcuni giorni della settimana'),
    el('option', { value: 'RANGE' }, 'Intervallo di date'),
  );
  mode.value = String(dish.schedule_mode ?? 'ALWAYS');
  const availableFrom = field(
    'Data / inizio intervallo',
    'available-from',
    'date',
    String(dish.available_from ?? ''),
  );
  const availableUntil = field(
    'Fine intervallo',
    'available-until',
    'date',
    String(dish.available_until ?? ''),
  );
  const weekdayLabels = [
    [1, 'Lunedì'],
    [2, 'Martedì'],
    [3, 'Mercoledì'],
    [4, 'Giovedì'],
    [5, 'Venerdì'],
    [6, 'Sabato'],
    [7, 'Domenica'],
  ] as const;
  const selectedWeekdays = Array.isArray(dish.weekdays)
    ? new Set(dish.weekdays.filter((day): day is number => typeof day === 'number'))
    : new Set<number>();
  const weekdayInputs = weekdayLabels.map(([value, label]) => {
    const input = el('input', { type: 'checkbox', value: String(value) });
    input.checked = selectedWeekdays.has(value);
    return { value, input, root: el('label', {}, input, label) };
  });
  const dates = el('div', { class: 'stack' }, availableFrom.root, availableUntil.root);
  const weekdays = el(
    'div',
    { class: 'stack' },
    el('h3', {}, 'Giorni della settimana'),
    el('div', { class: 'row wrap' }, ...weekdayInputs.map((entry) => entry.root)),
  );
  const hint = el('p', { class: 'muted' });
  function updateVisibility(): void {
    const selected = mode.value;
    availableFrom.root.hidden = selected === 'ALWAYS' || selected === 'WEEKDAYS';
    availableUntil.root.hidden = selected !== 'RANGE';
    weekdays.hidden = selected !== 'WEEKDAYS';
    hint.textContent =
      selected === 'ALWAYS'
        ? 'Il piatto è ordinabile ogni giorno, salvo disponibilità della sede.'
        : selected === 'DATE'
          ? 'Il piatto è ordinabile esclusivamente nella data indicata.'
          : selected === 'WEEKDAYS'
            ? 'Il piatto è ordinabile soltanto nei giorni selezionati.'
            : 'Il piatto è ordinabile dal giorno iniziale al giorno finale, inclusi.';
  }
  mode.addEventListener('change', updateVisibility);
  const popup = dialog(
    `Disponibilità temporale · ${String(dish.name)}`,
    el('label', {}, 'Regola', mode),
    hint,
    dates,
    weekdays,
  );
  updateVisibility();
  const key = crypto.randomUUID();
  popup.append(
    button('Salva disponibilità', async () => {
      const selected = mode.value;
      let from: string | null = null;
      let until: string | null = null;
      let days: number[] = [];
      if (selected === 'DATE') {
        availableFrom.input.required = true;
        if (!availableFrom.input.reportValidity()) return;
        from = availableFrom.input.value;
      } else if (selected === 'WEEKDAYS') {
        days = weekdayInputs.filter((entry) => entry.input.checked).map((entry) => entry.value);
        if (!days.length) {
          toast('Seleziona almeno un giorno della settimana.', true);
          return;
        }
      } else if (selected === 'RANGE') {
        availableFrom.input.required = true;
        availableUntil.input.required = true;
        if (!availableFrom.input.reportValidity() || !availableUntil.input.reportValidity()) return;
        from = availableFrom.input.value;
        until = availableUntil.input.value;
        if (until < from) {
          toast('La data finale non può precedere quella iniziale.', true);
          return;
        }
      }
      await rpc(
        'save_configuration_command',
        {
          p_entity: 'dishes',
          p_key: key,
          p_venue: null,
          p_id: id,
          p_values: {
            schedule_mode: selected,
            available_from: from,
            available_until: until,
            weekdays: days,
          },
          p_version: dish.version,
        },
        record,
      );
      popup.close();
      toast('Disponibilità temporale aggiornata.');
      await context.refresh?.();
    }),
  );
}

export async function venueDishDialog(
  context: StaffContext,
  dish: Record<string, unknown>,
): Promise<void> {
  const [settings, stations, links] = await Promise.all([
    readRows('venue_dish_settings', record, context.venue?.id, { dish_id: String(dish.id) }),
    readRows('stations', record, context.venue?.id, { active: 'true' }),
    readRows('dish_station_assignments', record, context.venue?.id, { dish_id: String(dish.id) }),
  ]);
  const current = settings[0];
  const price = field(
    'Prezzo della sede (€); vuoto = catalogo',
    'local-price',
    'text',
    typeof current?.local_price_cents === 'number'
      ? (current.local_price_cents / 100).toFixed(2)
      : '',
  );
  price.input.inputMode = 'decimal';
  const stock = field(
    'Porzioni di oggi; vuoto = senza limite',
    'stock',
    'number',
    String(current?.availability ?? ''),
  );
  stock.input.min = '0';
  stock.input.max = '1000000';
  const enabled = el('input', { type: 'checkbox' });
  enabled.checked = current?.enabled !== false;
  const primary = el(
    'select',
    { 'aria-label': 'Stazione principale' },
    ...stations.map((s) => el('option', { value: String(s.id) }, String(s.name))),
  );
  primary.value = String(
    current?.local_station_id ??
      links.find((l) => l.is_primary)?.station_id ??
      stations[0]?.id ??
      '',
  );
  const observers = stations.map((s) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = links.some((l) => l.station_id === s.id && !l.is_primary);
    return { id: s.id, input, root: el('label', {}, input, String(s.name)) };
  });
  const popup = dialog(
    `Disponibilità e stazioni · ${String(dish.name)}`,
    el('label', {}, enabled, 'Ordinabile in questa sede'),
    price.root,
    stock.root,
    el('label', {}, 'Stazione principale', primary),
    el('h3', {}, 'Stazioni osservatrici'),
    ...observers.map((o) => o.root),
  );
  const key = crypto.randomUUID();
  popup.append(
    button('Salva per oggi', async () => {
      if (!stock.input.reportValidity()) return;
      await rpc(
        'save_venue_dish',
        {
          p_venue: context.venue?.id,
          p_dish: dish.id,
          p_version: current?.version ?? null,
          p_enabled: enabled.checked,
          p_price: price.input.value ? Number(parseMoney(price.input.value)) : null,
          p_availability: stock.input.value ? Number(stock.input.value) : null,
          p_primary_station: primary.value,
          p_observers: observers
            .filter((o) => o.input.checked && o.id !== primary.value)
            .map((o) => o.id),
          p_key: key,
        },
        record,
      );
      popup.close();
      toast('Disponibilità aggiornata.');
      await context.refresh?.();
    }),
  );
}
