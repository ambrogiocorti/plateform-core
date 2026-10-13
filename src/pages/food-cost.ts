import { z } from 'zod';
import { client, readRows, rpc, safeError } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import { formatMoney } from '../services/money';
import { parsePurchaseCostMicros } from '../services/food-cost';
import type { StaffContext } from './staff-context';

const record = z.record(z.string(), z.unknown());
const foodCostSchema = z.object({
  recipe_lines: z.number().int(),
  recipe_complete: z.boolean(),
  cost_complete: z.boolean(),
  food_cost_cents: z.number().int().nullable(),
  food_cost_percentage: z.number().nullable(),
  gross_margin_cents: z.number().int().nullable(),
  lines: z.array(record),
});

export async function foodCostLicensed(context: StaffContext): Promise<boolean> {
  if (!context.venue) return false;
  const flags = await readRows(
    'feature_flags',
    z.object({ name: z.string(), licensed: z.boolean() }),
    undefined,
    { name: 'FOOD_COST' },
  );
  if (!flags.some((flag) => flag.licensed && flag.name === 'FOOD_COST')) return false;
  const { data, error } = await client()
    .from('venue_features')
    .select('enabled')
    .eq('venue_id', context.venue.id)
    .eq('name', 'FOOD_COST')
    .maybeSingle();
  if (error) throw safeError(error);
  return data?.enabled === true;
}

export async function ingredientCostDialog(
  context: StaffContext,
  ingredient: Record<string, unknown>,
): Promise<void> {
  const venue = context.venue;
  if (!venue) {
    toast('Seleziona una sede prima di aggiornare il costo.', true);
    return;
  }
  const ingredientId = z.uuid().parse(ingredient.id);
  const cost = field('Costo di acquisto (€ per unità)', 'purchase-cost', 'text');
  cost.input.inputMode = 'decimal';
  cost.input.placeholder = 'Es. 4,250000';
  cost.input.required = true;
  cost.input.maxLength = 14;
  const unit = el(
    'select',
    { 'aria-label': 'Unità di acquisto' },
    el('option', { value: 'G' }, 'Grammo (g)'),
    el('option', { value: 'KG' }, 'Chilogrammo (kg)'),
    el('option', { value: 'ML' }, 'Millilitro (ml)'),
    el('option', { value: 'L' }, 'Litro (l)'),
    el('option', { value: 'PIECE' }, 'Pezzo'),
  );
  const source = field('Fornitore / riferimento (facoltativo)', 'cost-source', 'text');
  source.input.maxLength = 160;
  const idempotencyKey = crypto.randomUUID();
  const effectiveFrom = new Date().toISOString();
  const popup = dialog(
    `Costo ingrediente · ${String(ingredient.name)}`,
    el('p', { class: 'muted' }, 'Registra una nuova quotazione storica per questa sede. La quotazione precedente verrà chiusa dalla procedura server.'),
    cost.root,
    el('label', {}, 'Unità di acquisto', unit),
    source.root,
  );
  popup.append(
    button('Registra costo', async () => {
      if (!cost.input.reportValidity() || !source.input.reportValidity()) return;
      let costMicros: number;
      try {
        costMicros = parsePurchaseCostMicros(cost.input.value);
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Costo non valido.', true);
        return;
      }
      await rpc('set_ingredient_cost', {
        p_ingredient: ingredientId,
        p_venue: venue.id,
        p_cost_micros: costMicros,
        p_purchase_unit: unit.value,
        p_effective_from: effectiveFrom,
        p_source: source.input.value.trim() || null,
        p_key: idempotencyKey,
      }, z.object({ id: z.uuid() }));
      popup.close();
      toast('Costo di acquisto registrato nello storico della sede.');
      await context.refresh?.();
    }),
  );
}

export async function dishFoodCostDialog(
  context: StaffContext,
  dish: Record<string, unknown>,
): Promise<void> {
  const venue = context.venue;
  if (!venue) {
    toast('Seleziona una sede per consultare il costo del piatto.', true);
    return;
  }
  const dishId = z.uuid().parse(dish.id);
  const data = await rpc('get_dish_food_cost', {
    p_dish: dishId,
    p_venue: venue.id,
  }, foodCostSchema);
  const lines = el(
    'ul',
    {},
    ...data.lines.map((line) =>
      el(
        'li',
        {},
        `${String(line.ingredient_name ?? 'Ingrediente')}: ${line.line_cost_micros === null || line.line_cost_micros === undefined ? 'Costo non disponibile' : formatMoney(Math.round(Number(line.line_cost_micros) / 10000))}`,
      ),
    ),
  );
  const complete = data.recipe_complete && data.cost_complete;
  const popup = dialog(
    `Food cost · ${String(dish.name)}`,
    el('p', {}, `Righe ricetta: ${data.recipe_lines}`),
    el('p', {}, complete ? `Costo totale: ${formatMoney(data.food_cost_cents ?? 0)}` : 'Ricetta o costi incompleti: aggiungi quantità e quotazioni per tutti gli ingredienti.'),
    complete ? el('p', {}, `Incidenza: ${data.food_cost_percentage ?? 0}% · Margine lordo: ${formatMoney(data.gross_margin_cents ?? 0)}`) : null,
    lines,
  );
  if (complete) {
    const idempotencyKey = crypto.randomUUID();
    popup.append(
      button('Registra snapshot del margine', async () => {
        await rpc('snapshot_dish_food_cost', {
          p_dish: dishId,
          p_venue: venue.id,
          p_key: idempotencyKey,
        }, z.object({ id: z.uuid() }));
        popup.close();
        toast('Snapshot del food cost registrato.');
        await context.refresh?.();
      }),
    );
  }
}
