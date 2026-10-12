import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, emptyState, field, status } from '../components/dom';
import { formatMoney } from '../services/money';
import {
  engineeringClassificationLabel,
  validMenuEngineeringPeriod,
} from '../services/menu-engineering';
import type { StaffContext } from './staff-context';

const uuid = z.uuid();
const nullableMoney = z.number().int().nullable();
const categorySchema = z.object({ id: uuid, name: z.string(), active: z.boolean() });
const reportItemSchema = z.object({
  dish_id: uuid,
  name: z.string(),
  category_id: uuid,
  category_name: z.string(),
  active: z.boolean(),
  selling_price_cents: z.number().int(),
  units_sold: z.number().int(),
  voided_units: z.number().int(),
  net_revenue_cents: z.number().int(),
  food_cost_complete: z.boolean(),
  food_cost_cents: nullableMoney,
  food_cost_percentage: z.number().nullable(),
  gross_margin_cents: nullableMoney,
  gross_margin_percentage: z.number().nullable(),
  classification: z.string(),
});
const reportSchema = z.object({
  venue_id: uuid,
  start_date: z.string(),
  end_date: z.string(),
  category_id: uuid.nullable(),
  cost_basis: z.literal('PERIOD_END_THEORETICAL'),
  items: z.array(reportItemSchema),
});
const costSchema = z.object({
  dish_id: uuid,
  recipe_lines: z.number().int(),
  recipe_complete: z.boolean(),
  cost_complete: z.boolean(),
  food_cost_cents: nullableMoney,
  food_cost_percentage: z.number().nullable(),
  gross_margin_cents: nullableMoney,
  gross_margin_percentage: z.number().nullable(),
  lines: z.array(
    z.object({
      ingredient_name: z.string(),
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
      cost_source: z.enum(['CHAIN', 'VENUE']).nullable(),
      purchase_unit: z.string().nullable(),
    }),
  ),
});

export async function menuEngineeringPage(context: StaffContext): Promise<HTMLElement> {
  if (context.profile.role !== 'ADMIN')
    return emptyState('Accesso non autorizzato', 'Il food cost è riservato agli Admin.');
  const venue = context.venue;
  if (!venue)
    return emptyState('Nessuna sede', 'Seleziona una sede autorizzata.');

  const flags = await readRows('feature_flags', z.object({
    name: z.string(),
    licensed: z.boolean(),
  }));
  if (!flags.some((flag) => flag.name === 'FOOD_COST' && flag.licensed))
    return emptyState(
      'Food cost non abilitato',
      'Questa funzione avanzata non è compresa nella licenza attuale. Non è disponibile nell’edizione CORE.',
    );

  const categories = await readRows('categories', categorySchema);
  const category = el(
    'select',
    { 'aria-label': 'Categoria del menu' },
    el('option', { value: '' }, 'Tutte le categorie'),
    ...categories.map((item) =>
      el('option', { value: item.id }, item.name),
    ),
  );
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone: venue.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const start = field('Dal giorno', 'menu-engineering-start', 'date', today.slice(0, 8) + '01');
  const end = field('Al giorno', 'menu-engineering-end', 'date', today);
  start.input.required = true;
  end.input.required = true;

  const money = (cents: number) => formatMoney(cents, venue.currency, venue.locale);
  const results = el('section', { class: 'stack', 'aria-live': 'polite' });
  let revision = 0;

  async function load(): Promise<void> {
    const beginning = start.input.value;
    const ending = end.input.value;
    if (!validMenuEngineeringPeriod(beginning, ending))
      throw new Error('Seleziona un periodo reale di massimo 366 giorni, con inizio non successivo alla fine.');
    const currentRevision = ++revision;
    const response = await rpc('get_menu_engineering', {
      p_venue: venue.id,
      p_start: beginning,
      p_end: ending,
      p_category: category.value || null,
    }, reportSchema);
    if (currentRevision !== revision) return;
    results.replaceChildren(
      el(
        'div',
        { class: 'card stack' },
        el('h2', {}, 'Andamento del menu'),
        el('p', {}, `${response.items.length} piatti · ${response.start_date} – ${response.end_date}`),
        el(
          'p',
          { class: 'muted' },
          'Food cost e margini calcolati dal server come valori teorici al termine del periodo. Il margine lordo non è utile netto e non include tutti i costi operativi.',
        ),
      ),
    );
    if (!response.items.length) {
      results.append(emptyState('Nessun piatto per il periodo', 'Modifica le date o la categoria.'));
      return;
    }
    for (const dish of response.items) {
      const card = el(
        'article',
        { class: 'card stack' },
        el(
          'div',
          { class: 'row between' },
          el('h3', {}, dish.name),
          status(engineeringClassificationLabel(dish.classification)),
        ),
        el('p', { class: 'muted' }, dish.category_name),
        el(
          'p',
          {},
          `${dish.units_sold} unità vendute · ${dish.voided_units} annullate · Ricavi netti ${money(dish.net_revenue_cents)}`,
        ),
        dish.food_cost_complete && dish.food_cost_cents !== null
          ? el(
              'p',
              {},
              `Food cost teorico ${money(dish.food_cost_cents)} (${dish.food_cost_percentage ?? 'n.d.'}%) · Margine lordo teorico ${dish.gross_margin_cents === null ? 'n.d.' : money(dish.gross_margin_cents)} (${dish.gross_margin_percentage ?? 'n.d.'}%)`,
            )
          : el(
              'p',
              { role: 'status' },
              'Ricetta o storico costi incompleto: margine non calcolabile.',
            ),
      );
      card.append(
        button(
          'Composizione del costo',
          async () => {
            const cost = await rpc(
              'get_dish_food_cost',
              { p_dish: dish.dish_id, p_venue: venue.id },
              costSchema,
            );
            dialog(
              `Food cost · ${dish.name}`,
              el(
                'p',
                { class: 'muted' },
                cost.cost_complete
                  ? 'Costo teorico basato su ingredienti e prezzi di acquisto registrati.'
                  : 'Ricetta o prezzi ingrediente incompleti: il costo non è disponibile.',
              ),
              cost.food_cost_cents !== null
                ? el('strong', {}, `Costo piatto: ${money(cost.food_cost_cents)}`)
                : null,
              ...cost.lines.map((line) =>
                el(
                  'p',
                  {},
                  `${line.ingredient_name}: ${line.quantity ?? 'quantità non definita'} ${line.unit ?? ''} · ${line.cost_source === null ? 'costo non definito' : `prezzo ${line.cost_source === 'VENUE' ? 'della sede' : 'di catena'}`}`,
                ),
              ),
            );

          },
          'secondary',
        ),
      );
      results.append(card);
    }
  }

  const submit = button('Calcola analisi', load);
  const root = el(
    'section',
    { class: 'stack' },
    el(
      'header',
      { class: 'card stack' },
      el('p', { class: 'eyebrow' }, 'FOOD COST E MENU ENGINEERING'),
      el('h2', {}, `Analisi economica · ${venue.name}`),
      el(
        'p',
        { class: 'muted' },
        'Solo dati autorizzati della sede. Nessun prezzo, costo o margine è calcolato dal browser: il risultato economico proviene da PostgreSQL.',
      ),
    ),
    el(
      'div',
      { class: 'card stack' },
      start.root,
      end.root,
      el('label', { class: 'field' }, 'Categoria', category),
      submit,
    ),
    results,
  );
  context.refresh = load;
  return root;
}
