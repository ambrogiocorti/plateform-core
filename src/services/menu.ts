import type { MenuDish, OrderLine } from '../types/domain';

export function availabilityBadge(quantity: number | null): {
  label: string;
  severity: 'none' | 'warning' | 'urgent' | 'sold-out';
} {
  if (quantity !== null && (!Number.isInteger(quantity) || quantity < 0))
    throw new Error('Disponibilità non valida.');
  if (quantity === null || quantity > 10) return { label: '', severity: 'none' };
  if (quantity === 0) return { label: 'Esaurito', severity: 'sold-out' };
  if (quantity === 1) return { label: 'Ultima porzione', severity: 'urgent' };
  return { label: `Ultime ${quantity} porzioni`, severity: quantity <= 5 ? 'urgent' : 'warning' };
}

export function validateOrderSelection(dish: MenuDish, line: OrderLine): string[] {
  const errors: string[] = [];
  if (dish.id !== line.dish_id) errors.push('Piatto non corrispondente.');
  if (dish.availability !== null && line.quantity > dish.availability)
    errors.push('Porzioni insufficienti.');
  if (
    new Set(line.removed_ingredients).size !== line.removed_ingredients.length ||
    new Set(line.variant_options).size !== line.variant_options.length
  )
    errors.push('Selezione duplicata.');
  if (
    line.removed_ingredients.some(
      (id) => !dish.ingredients.some((item) => item.id === id && item.removable),
    )
  )
    errors.push('Ingrediente non removibile.');
  const options = new Set(
    dish.variant_groups.flatMap((group) => group.options.map((option) => option.id)),
  );
  if (line.variant_options.some((id) => !options.has(id))) errors.push('Variante non disponibile.');
  for (const group of dish.variant_groups) {
    const selected = group.options.filter((option) =>
      line.variant_options.includes(option.id),
    ).length;
    if ((group.required && selected === 0) || selected > group.max_selections)
      errors.push(`Verifica le opzioni di ${group.name}.`);
  }
  return errors;
}
