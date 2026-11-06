import { button, el, field, status } from './dom';
import { availabilityBadge } from '../services/menu';
import { formatMoney } from '../services/money';
import type { MenuDish, OrderLine } from '../types/domain';
import '../../styles/order-composer.css';

export type OrderComposer = {
  root: HTMLElement;
  summary: HTMLElement;
  items: () => OrderLine[];
  reportValidity: () => boolean;
};

/** Keeps the catalogue mounted: filtering and cart updates never erase customisations. */
export function orderComposer(dishes: MenuDish[]): OrderComposer {
  const cart = new Map<string, OrderLine>();
  const controls = new Map<string, { quantity: HTMLInputElement; step: HTMLInputElement }>();
  const cards = new Map<string, HTMLElement>();
  const search = field('Cerca un piatto', 'order-search', 'search');
  search.input.placeholder = 'Nome o ingrediente…';
  search.input.autocomplete = 'off';
  search.input.setAttribute('aria-label', 'Cerca un piatto');
  const results = el('p', { class: 'composer-results', role: 'status', 'aria-live': 'polite' });
  const catalogue = el('div', { class: 'composer-catalogue', 'aria-label': 'Piatti del menu' });
  const categories = el('div', { class: 'composer-categories', 'aria-label': 'Categorie menu' });
  const cartList = el('div', { class: 'composer-cart-lines', 'aria-label': 'Piatti selezionati' });
  const count = el('span', { class: 'composer-cart-count' }, '0');
  const total = el('strong', { class: 'composer-total' }, formatMoney(0));
  const summary = el('p', { class: 'composer-summary', role: 'status', 'aria-live': 'polite' });
  const noResults = el(
    'div',
    { class: 'composer-no-results', hidden: '' },
    el('h3', {}, 'Nessun piatto trovato'),
    el('p', { class: 'muted' }, 'Prova un altro nome o cambia categoria.'),
  );
  let selectedCategory = '';

  function updateCart(): void {
    let quantity = 0;
    let amount = 0;
    cartList.replaceChildren();
    for (const dish of dishes) {
      const line = cart.get(dish.id);
      const card = cards.get(dish.id);
      card?.classList.toggle('is-selected', Boolean(line));
      if (!line) continue;
      quantity += line.quantity;
      amount += line.quantity * dish.price_cents;
      const modifications = [
        ...dish.ingredients
          .filter((ingredient) => line.removed_ingredients.includes(ingredient.id))
          .map((ingredient) => `Senza ${ingredient.name}`),
        ...dish.variant_groups.flatMap((group) =>
          group.options
            .filter((option) => line.variant_options.includes(option.id))
            .map((option) => option.label),
        ),
      ];
      const remove = button(
        'Rimuovi',
        () => {
          controls.get(dish.id)!.quantity.value = '0';
          line.quantity = 0;
          cart.delete(dish.id);
          updateCart();
          controls.get(dish.id)!.quantity.focus();
        },
        'quiet',
      );
      remove.setAttribute('aria-label', `Rimuovi ${dish.name} dalla comanda`);
      cartList.append(
        el(
          'article',
          { class: 'composer-cart-line' },
          el('span', { class: 'composer-line-quantity' }, `${line.quantity}×`),
          el(
            'div',
            { class: 'composer-line-copy' },
            el('strong', {}, dish.name),
            el('span', {}, `Uscita ${line.step}`),
            modifications.length
              ? el('p', { class: 'composer-line-modifiers' }, modifications.join(' · '))
              : null,
            remove,
          ),
          el('strong', {}, formatMoney(line.quantity * dish.price_cents)),
        ),
      );
    }
    if (!quantity)
      cartList.append(
        el(
          'div',
          { class: 'composer-cart-empty' },
          el('span', { class: 'composer-empty-symbol', 'aria-hidden': 'true' }, '＋'),
          el('h3', {}, 'La comanda inizia qui'),
          el('p', {}, 'Aggiungi i piatti dal menu. Li ritroverai qui, divisi per uscita.'),
        ),
      );
    count.textContent = String(quantity);
    total.textContent = formatMoney(amount);
    summary.textContent = quantity
      ? `${quantity} ${quantity === 1 ? 'piatto selezionato' : 'piatti selezionati'} · ${formatMoney(amount)} indicativi`
      : 'Nessun piatto selezionato';
  }

  function filter(): void {
    const query = search.input.value.trim().toLocaleLowerCase('it-IT');
    let visible = 0;
    for (const dish of dishes) {
      const matches =
        (!selectedCategory || dish.category_id === selectedCategory) &&
        (!query ||
          `${dish.name} ${dish.ingredients.map((ingredient) => ingredient.name).join(' ')}`
            .toLocaleLowerCase('it-IT')
            .includes(query));
      cards.get(dish.id)!.hidden = !matches;
      if (matches) visible++;
    }
    results.textContent = `${visible} ${visible === 1 ? 'piatto' : 'piatti'} nel menu`;
    noResults.hidden = visible > 0;
  }

  const groups = new Map(dishes.map((dish) => [dish.category_id, dish.category_name]));
  for (const [id, label] of [['', 'Tutti'], ...groups.entries()]) {
    const control = button(
      label!,
      () => {
        selectedCategory = id!;
        for (const item of categories.querySelectorAll<HTMLButtonElement>('button'))
          item.setAttribute('aria-pressed', String(item === control));
        filter();
      },
      'secondary',
    );
    control.setAttribute('aria-pressed', String(id === ''));
    categories.append(control);
  }

  for (const dish of dishes) {
    const quantity = field('Quantità', `qty-${dish.id}`, 'number', '0');
    quantity.input.min = '0';
    quantity.input.max = String(Math.min(dish.availability ?? 999, 999));
    quantity.input.step = '1';
    quantity.input.inputMode = 'numeric';
    quantity.input.disabled = dish.availability === 0;
    const step = field('Uscita', `step-${dish.id}`, 'number', '1');
    step.input.min = '1';
    step.input.max = '99';
    step.input.step = '1';
    step.input.inputMode = 'numeric';
    controls.set(dish.id, { quantity: quantity.input, step: step.input });
    const line: OrderLine = {
      dish_id: dish.id,
      quantity: 0,
      step: 1,
      removed_ingredients: [],
      variant_options: [],
    };
    const update = () => {
      line.quantity = Number(quantity.input.value);
      line.step = Number(step.input.value);
      if (line.quantity > 0) cart.set(dish.id, line);
      else cart.delete(dish.id);
      updateCart();
    };
    quantity.input.addEventListener('input', update);
    step.input.addEventListener('input', update);
    const minus = button(
      '−',
      () => {
        quantity.input.stepDown();
        update();
      },
      'secondary',
    );
    const plus = button(
      '+',
      () => {
        quantity.input.stepUp();
        update();
      },
      'secondary',
    );
    minus.setAttribute('aria-label', `Riduci quantità di ${dish.name}`);
    plus.setAttribute('aria-label', `Aggiungi ${dish.name}`);
    minus.disabled = plus.disabled = dish.availability === 0;
    quantity.root.classList.add('composer-quantity');
    quantity.root.append(el('div', { class: 'composer-stepper' }, minus, quantity.input, plus));
    step.root.classList.add('composer-step');
    const availability = availabilityBadge(dish.availability);
    const item = el(
      'article',
      { class: 'menu-choice composer-dish', 'data-dish': dish.id },
      el(
        'div',
        { class: 'composer-dish-heading' },
        el(
          'div',
          {},
          el('span', { class: 'composer-category' }, dish.category_name),
          el('h3', {}, dish.name),
        ),
        el('strong', { class: 'composer-dish-price' }, formatMoney(dish.price_cents)),
      ),
      dish.ingredients.length
        ? el(
            'p',
            { class: 'composer-ingredients' },
            dish.ingredients.map((ingredient) => ingredient.name).join(', '),
          )
        : null,
      el(
        'div',
        { class: 'composer-dish-meta' },
        dish.allergens.length
          ? el(
              'span',
              {},
              `Allergeni: ${dish.allergens.map((allergen) => allergen.name).join(', ')}`,
            )
          : null,
        availability.label ? status(availability.label) : null,
      ),
      el('div', { class: 'composer-dish-controls' }, quantity.root, step.root),
    );
    const options = el('details', { class: 'composer-options' });
    options.append(el('summary', {}, 'Varianti e ingredienti'));
    for (const ingredient of dish.ingredients.filter((ingredient) => ingredient.removable)) {
      const check = el('input', { type: 'checkbox' });
      check.addEventListener('change', () => {
        line.removed_ingredients = check.checked
          ? [...line.removed_ingredients, ingredient.id]
          : line.removed_ingredients.filter((id) => id !== ingredient.id);
        updateCart();
      });
      options.append(el('label', { class: 'checkbox-line' }, check, `Senza ${ingredient.name}`));
    }
    for (const group of dish.variant_groups) {
      const choices = el(
        'fieldset',
        {},
        el('legend', {}, `${group.name}${group.required ? ' · obbligatoria' : ''}`),
        el('p', { class: 'muted' }, `Scegli fino a ${group.max_selections}`),
      );
      for (const option of group.options) {
        const check = el('input', { type: 'checkbox' });
        check.addEventListener('change', () => {
          line.variant_options = check.checked
            ? [...line.variant_options, option.id]
            : line.variant_options.filter((id) => id !== option.id);
          updateCart();
        });
        choices.append(el('label', { class: 'checkbox-line' }, check, option.label));
      }
      options.append(choices);
      if (group.required) options.open = true;
    }
    if (options.childElementCount > 1) item.append(options);
    cards.set(dish.id, item);
    catalogue.append(item);
  }
  search.input.addEventListener('input', filter);
  filter();
  updateCart();
  const root = el(
    'div',
    { class: 'order-composer' },
    el(
      'section',
      { class: 'composer-menu', 'aria-label': 'Scegli i piatti' },
      el('div', { class: 'composer-toolbar' }, search.root, results, categories),
      el('div', { class: 'composer-catalogue-scroll' }, catalogue, noResults),
    ),
    el(
      'aside',
      { class: 'composer-cart', 'aria-label': 'Riepilogo comanda' },
      el('header', {}, el('h3', {}, 'La comanda'), count),
      cartList,
      el(
        'footer',
        {},
        el('div', { class: 'row between' }, el('span', {}, 'Totale indicativo'), total),
        el('p', {}, 'Prezzi e disponibilità confermati all’invio.'),
      ),
    ),
  );
  return {
    root,
    summary,
    items: () => Array.from(cart.values()),
    reportValidity: () => {
      for (const [id] of cart) {
        const input = controls.get(id)!;
        if (!input.quantity.checkValidity() || !input.step.checkValidity()) {
          selectedCategory = '';
          search.input.value = '';
          for (const control of categories.querySelectorAll<HTMLButtonElement>('button'))
            control.setAttribute('aria-pressed', String(control === categories.firstElementChild));
          filter();
          return input.quantity.reportValidity() && input.step.reportValidity();
        }
      }
      return true;
    },
  };
}
