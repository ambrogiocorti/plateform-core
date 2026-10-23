import { z } from 'zod';
import { rpc } from '../api/client';
import { el, emptyState } from '../components/dom';
import { safeImageUrl } from '../config/environment';
import { availabilityBadge } from '../services/menu';
import { formatMoney } from '../services/money';
import type { Venue } from '../types/domain';

const item = z.object({
  id: z.uuid(),
  name: z.string(),
  // Optional in the catalog: a dish saved without one comes back as null.
  description: z
    .string()
    .nullable()
    .transform((value) => value ?? ''),
  image_path: z.string().nullable(),
  beverage: z.boolean(),
  price_cents: z.number().int().nonnegative(),
  availability: z.number().int().nonnegative().nullable(),
  ingredients: z.array(z.object({ id: z.uuid(), name: z.string(), removable: z.boolean() })),
  allergens: z.array(z.object({ code: z.string(), name: z.string() })),
  dietary_tags: z.array(z.object({ code: z.string(), label: z.string() })),
});
const payloadSchema = z.object({
  venue_id: z.uuid(),
  menu: z.object({ public_menu_id: z.uuid(), slug: z.string(), name: z.string() }),
  categories: z.array(z.object({ id: z.uuid(), name: z.string(), items: z.array(item) })),
});
const indexSchema = z.object({
  menus: z.array(z.object({ id: z.uuid(), slug: z.string(), name: z.string() })),
});
export async function publishedMenuIndex(
  venue: Venue,
  multiVenue: boolean,
): Promise<HTMLElement | null> {
  const index = await rpc('get_public_navigation', { p_venue: venue.id }, indexSchema);
  if (!index.menus.length) return null;
  const section = el('section', { class: 'public-section' }, el('h2', {}, 'Le nostre carte'));
  const links = el('div', { class: 'grid' });
  for (const menu of index.menus) {
    const target = `/menu/${encodeURIComponent(menu.slug)}${multiVenue ? `?sede=${encodeURIComponent(venue.slug)}` : ''}`;
    links.append(el('a', { href: target, class: 'card' }, menu.name));
  }
  section.append(links);
  return section;
}

export async function publishedMenuPage(slug: string, venue: Venue): Promise<HTMLElement> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80)
    return emptyState('Menu non disponibile', 'La carta richiesta non è valida.', 'h1');
  const result = await rpc(
    'get_public_menu_by_slug',
    { p_slug: slug, p_venue: venue.id },
    payloadSchema,
  );
  if (result.venue_id !== venue.id || result.menu.slug !== slug)
    throw new Error('INVALID_MENU_CONTEXT');
  const page = el(
    'section',
    { class: 'public-section' },
    el('p', { class: 'eyebrow' }, 'La nostra cucina'),
    el('h1', {}, result.menu.name),
  );
  for (const category of result.categories) {
    page.append(el('h2', { class: 'menu-category' }, category.name));
    const cards = el('div', { class: 'dish-grid' });
    for (const dish of category.items) {
      const image = safeImageUrl(dish.image_path);
      const availability = availabilityBadge(dish.availability);
      cards.append(
        el(
          'article',
          { class: 'dish-public' },
          image
            ? el('img', { src: image, alt: dish.name, loading: 'lazy', decoding: 'async' })
            : null,
          el(
            'div',
            { class: 'row between' },
            el('h3', {}, dish.name),
            el('strong', {}, formatMoney(dish.price_cents, venue.currency, venue.locale)),
          ),
          el('p', {}, dish.description),
          !dish.beverage && dish.ingredients.length
            ? el('p', {}, dish.ingredients.map((i) => i.name).join(', '))
            : null,
          dish.allergens.length
            ? el(
                'p',
                { class: 'allergens' },
                `Contiene: ${dish.allergens.map((a) => a.name).join(', ')}`,
              )
            : null,
          el(
            'div',
            { class: 'row' },
            ...dish.dietary_tags.map((tag) => el('span', { class: 'status' }, tag.label)),
            availability.label ? el('span', { class: 'status' }, availability.label) : null,
          ),
        ),
      );
    }
    page.append(cards);
  }
  if (!result.categories.length)
    page.append(
      el(
        'p',
        { class: 'muted' },
        'Questa carta non contiene piatti disponibili in questo momento.',
      ),
    );
  return page;
}
