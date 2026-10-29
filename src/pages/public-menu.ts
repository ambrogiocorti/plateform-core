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
  description: z.string(),
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
  promotions: z
    .array(
      z.object({
        id: z.uuid(),
        display_mode: z.string(),
        title: z.string(),
        body: z.string(),
        image_path: z.string().nullable(),
        cta_label: z.string().nullable(),
        priority: z.number(),
        max_impressions_per_session: z.number().int().nullable().optional(),
        target: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('CATEGORY'), id: z.uuid() }),
            z.object({ type: z.literal('DISH'), id: z.uuid() }),
            z.object({ type: z.literal('MENU'), public_menu_id: z.uuid(), slug: z.string() }),
          ])
          .nullable(),
      }),
    )
    .default([]),
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

export async function publishedMenuPage(
  slug: string,
  venue: Venue,
  dishId?: string,
): Promise<HTMLElement> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80)
    return emptyState('Menu non disponibile', 'La carta richiesta non è valida.');
  if (dishId && !z.uuid().safeParse(dishId).success)
    return emptyState('Piatto non disponibile', 'Il collegamento al piatto non è valido.');
  const result = await rpc(
    'get_public_menu_by_slug',
    { p_slug: slug, p_venue: venue.id },
    payloadSchema,
  );
  if (result.venue_id !== venue.id || result.menu.slug !== slug)
    throw new Error('INVALID_MENU_CONTEXT');
  const venueQuery = `?sede=${encodeURIComponent(venue.slug)}`;
  const menuPath = `/menu/${encodeURIComponent(slug)}${venueQuery}`;
  const dishPath = (id: string) => `/menu/${encodeURIComponent(slug)}/piatto/${id}${venueQuery}`;
  if (dishId) {
    const dish = result.categories
      .flatMap((category) => category.items)
      .find((item) => item.id === dishId);
    if (!dish)
      return emptyState(
        'Piatto non disponibile',
        'Questo piatto non è presente nella carta pubblicata.',
      );
    const image = safeImageUrl(dish.image_path);
    const badge = availabilityBadge(dish.availability);
    return el(
      'section',
      { class: 'public-section' },
      el('a', { href: menuPath, class: 'public-back-link' }, '← Torna alla carta'),
      el(
        'article',
        { class: 'public-dish-detail' },
        image
          ? el('img', {
              src: image,
              alt: dish.name,
              decoding: 'async',
              class: 'public-dish-detail-image',
            })
          : el(
              'div',
              {
                class: 'public-dish-image-placeholder',
                role: 'img',
                'aria-label': 'Foto non disponibile',
              },
              'La nostra cucina',
            ),
        el(
          'div',
          { class: 'public-dish-detail-content' },
          el('p', { class: 'eyebrow' }, 'Dalla nostra carta'),
          el('h1', {}, dish.name),
          el(
            'p',
            { class: 'public-dish-price' },
            formatMoney(dish.price_cents, venue.currency, venue.locale),
          ),
          el('p', {}, dish.description),
          dish.ingredients.length
            ? el(
                'section',
                {},
                el('h2', {}, 'Ingredienti'),
                el('p', {}, dish.ingredients.map((i) => i.name).join(', ')),
              )
            : null,
          dish.allergens.length
            ? el(
                'section',
                {},
                el('h2', {}, 'Allergeni'),
                el('p', {}, dish.allergens.map((a) => a.name).join(', ')),
              )
            : null,
          dish.dietary_tags.length || badge.label
            ? el(
                'div',
                { class: 'row' },
                ...dish.dietary_tags.map((tag) => el('span', { class: 'status' }, tag.label)),
                badge.label ? el('span', { class: 'status' }, badge.label) : null,
              )
            : null,
          el(
            'p',
            { class: 'muted' },
            'Per ordinare, inquadra il QR del tuo tavolo. Non serve creare un account.',
          ),
        ),
      ),
    );
  }
  const page = el(
    'section',
    { class: 'public-section' },
    el('p', { class: 'eyebrow' }, 'La nostra cucina'),
    el('h1', {}, result.menu.name),
  );
  const activePromotions = result.promotions.filter((promotion) => {
    const target = promotion.target;
    if (!target) return true;
    if (target.type === 'CATEGORY')
      return result.categories.some((category) => category.id === target.id);
    if (target.type === 'DISH')
      return result.categories.some((category) =>
        category.items.some((dish) => dish.id === target.id),
      );
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.slug);
  });
  if (activePromotions.length) {
    const promotions = el('div', {
      class: 'public-offers',
      'aria-label': 'Offerte in evidenza',
      tabindex: '0',
    });
    for (const promotion of activePromotions) {
      const image = safeImageUrl(promotion.image_path);
      const target = promotion.target;
      const href =
        target?.type === 'DISH'
          ? dishPath(target.id)
          : target?.type === 'CATEGORY'
            ? `#categoria-${target.id}`
            : target?.type === 'MENU'
              ? `/menu/${encodeURIComponent(target.slug)}${venueQuery}`
              : null;
      promotions.append(
        el(
          'article',
          { class: 'public-offer-card' },
          image ? el('img', { src: image, alt: '', loading: 'lazy' }) : null,
          el(
            'div',
            {},
            el('p', { class: 'eyebrow' }, 'In evidenza'),
            el('h3', {}, promotion.title),
            el('p', {}, promotion.body),
            href
              ? el(
                  'a',
                  { href, class: 'public-offer-link' },
                  promotion.cta_label || 'Scopri di più →',
                )
              : null,
          ),
        ),
      );
    }
    page.append(
      el(
        'section',
        { 'aria-label': 'Le nostre proposte' },
        el('h2', {}, 'Da scoprire'),
        promotions,
      ),
    );
  }
  const searchable: { element: HTMLElement; text: string }[] = [];
  const headings: { heading: HTMLElement; cards: HTMLElement }[] = [];
  if (result.categories.length) {
    const toolbar = el('div', { class: 'public-menu-toolbar' });
    const search = el('input', {
      type: 'search',
      class: 'public-menu-search',
      placeholder: 'Cerca un piatto, un ingrediente...',
      'aria-label': 'Cerca nella carta',
      autocomplete: 'off',
    });
    const results = el('span', { class: 'public-menu-results', role: 'status' });
    toolbar.append(search, results);
    const categoryNav = el(
      'nav',
      { class: 'public-category-nav', 'aria-label': 'Categorie del menu' },
      ...result.categories.map((category) =>
        el('a', { href: `#categoria-${category.id}` }, category.name),
      ),
    );
    page.append(toolbar, categoryNav);
    const simplify = (value: string) =>
      value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('it');
    search.addEventListener('input', () => {
      const query = simplify(search.value.trim());
      let visible = 0;
      for (const dish of searchable) {
        const match = !query || dish.text.includes(query);
        dish.element.hidden = !match;
        if (match) visible++;
      }
      for (const group of headings) {
        const shown = Array.from(group.cards.children).some(
          (entry) => !(entry as HTMLElement).hidden,
        );
        group.heading.hidden = !shown;
        group.cards.hidden = !shown;
      }
      results.textContent = visible === 1 ? '1 piatto' : `${visible} piatti`;
    });
    results.textContent = `${result.categories.reduce((total, category) => total + category.items.length, 0)} piatti`;
  }
  for (const category of result.categories) {
    const heading = el(
      'h2',
      { class: 'menu-category', id: `categoria-${category.id}` },
      category.name,
    );
    page.append(heading);
    const cards = el('div', { class: 'dish-grid' });
    headings.push({ heading, cards });
    for (const dish of category.items) {
      const image = safeImageUrl(dish.image_path);
      const availability = availabilityBadge(dish.availability);
      const card = el(
        'article',
        { class: 'dish-public public-dish-card' },
        el(
          'a',
          {
            href: dishPath(dish.id),
            class: 'public-dish-card-image',
            'aria-label': `Scopri ${dish.name}`,
          },
          image
            ? el('img', { src: image, alt: dish.name, loading: 'lazy', decoding: 'async' })
            : el('div', { class: 'public-dish-image-placeholder' }, 'La nostra cucina'),
        ),
        el(
          'div',
          { class: 'row between public-dish-card-title' },
          el('h3', {}, el('a', { href: dishPath(dish.id) }, dish.name)),
          el('strong', {}, formatMoney(dish.price_cents, venue.currency, venue.locale)),
        ),
        el('p', {}, dish.description),
        el(
          'div',
          { class: 'row' },
          ...dish.dietary_tags.map((tag) => el('span', { class: 'status' }, tag.label)),
          availability.label ? el('span', { class: 'status' }, availability.label) : null,
        ),
        el(
          'a',
          { href: dishPath(dish.id), class: 'public-dish-card-more' },
          'Dettagli e ingredienti →',
        ),
      );
      cards.append(card);
      searchable.push({
        element: card,
        text: [
          dish.name,
          dish.description,
          ...dish.ingredients.map((ingredient) => ingredient.name),
        ]
          .join(' ')
          .normalize('NFD')
          .replace(/\p{M}/gu, '')
          .toLocaleLowerCase('it'),
      });
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
