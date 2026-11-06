import { dialog, el } from './dom';
import { safeImageUrl } from '../config/environment';
import { availabilityBadge } from '../services/menu';
import { formatMoney } from '../services/money';
import type { MenuDish, Venue } from '../types/domain';

export function publicDishCard(dish: MenuDish, venue: Venue): HTMLElement {
  const picture = safeImageUrl(dish.image_path);
  const price = formatMoney(dish.price_cents, venue.currency, venue.locale);
  const availability = availabilityBadge(dish.availability);
  const allergens = dish.allergens.map((item) => item.name).join(', ');
  const card = el('article', { class: 'dish-public public-dish-card public-legacy-dish' });
  const open = el(
    'button',
    {
      type: 'button',
      class: 'dish-card-open',
      'aria-haspopup': 'dialog',
      'aria-label': `Scopri ${dish.name}`,
    },
    picture
      ? el('img', {
          src: picture,
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          class: 'dish-card-photo',
        })
      : null,
    el(
      'span',
      { class: 'dish-card-copy' },
      el(
        'span',
        { class: 'dish-card-heading' },
        el('h3', {}, dish.name),
        el('strong', { class: 'dish-card-price' }, price),
      ),
      el('span', { class: 'dish-card-description' }, dish.description),
      allergens ? el('span', { class: 'allergens' }, `Contiene: ${allergens}`) : null,
      el(
        'span',
        { class: 'dish-card-bottom' },
        availability.label
          ? el(
              'span',
              { class: 'dish-availability', 'data-severity': availability.severity },
              availability.label,
            )
          : null,
        el(
          'span',
          { class: 'dish-card-details' },
          'Scopri il piatto',
          el('span', { 'aria-hidden': 'true' }, '↗'),
        ),
      ),
    ),
  );
  // Ingredients remain available to menu search without making every card visually dense.
  card.dataset.search = [
    dish.name,
    dish.description,
    dish.category_name,
    ...dish.ingredients.map((item) => item.name),
    allergens,
    ...dish.dietary_tags.map((item) => item.label),
  ].join(' ');
  open.addEventListener('click', () => {
    const popup = dialog(
      dish.name,
      el(
        'div',
        { class: 'dish-detail-layout' },
        picture
          ? el(
              'div',
              { class: 'dish-detail-visual' },
              el('img', { src: picture, alt: dish.name, decoding: 'async' }),
            )
          : null,
        el(
          'div',
          { class: 'dish-detail-content' },
          el(
            'div',
            { class: 'dish-detail-meta' },
            el('span', { class: 'eyebrow' }, dish.category_name),
            el('strong', {}, price),
          ),
          el('p', { class: 'dish-detail-description' }, dish.description),
          dish.ingredients.length
            ? el(
                'section',
                { class: 'dish-detail-section' },
                el('h3', {}, 'Ingredienti'),
                el('p', {}, dish.ingredients.map((item) => item.name).join(', ')),
              )
            : null,
          allergens
            ? el(
                'section',
                { class: 'dish-detail-section dish-detail-allergens' },
                el('h3', {}, 'Allergeni'),
                el('p', {}, allergens),
              )
            : null,
          dish.dietary_tags.length
            ? el(
                'div',
                { class: 'dish-detail-tags' },
                ...dish.dietary_tags.map((tag) => el('span', {}, tag.label)),
              )
            : null,
          availability.label
            ? el(
                'p',
                { class: 'dish-availability', 'data-severity': availability.severity },
                availability.label,
              )
            : null,
        ),
      ),
    );
    popup.classList.add('dish-detail-dialog');
    if (picture) popup.classList.add('has-dish-photo');
  });
  card.append(open);
  return card;
}
