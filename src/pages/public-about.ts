import { z } from 'zod';
import { button, dialog, el } from '../components/dom';
import { safeImageUrl } from '../config/environment';
import type { PublicSite } from '../types/domain';

function copy(site: PublicSite, key: string, fallback = ''): string {
  return typeof site.content[key] === 'string' ? String(site.content[key]) : fallback;
}

export function restaurantPage(site: PublicSite): HTMLElement {
  const image = safeImageUrl(site.content.story_image_url ?? site.content.hero_image_url);
  const highlights = z
    .array(z.object({ title: z.string(), text: z.string() }))
    .safeParse(site.content.story_highlights);
  return el(
    'section',
    { class: 'public-section restaurant-about' },
    el(
      'header',
      { class: 'public-page-heading' },
      el('p', { class: 'eyebrow' }, site.name),
      el('h1', {}, copy(site, 'story_title', 'Il ristorante')),
      el(
        'p',
        { class: 'public-intro' },
        copy(site, 'story_intro', 'Il piacere di ritrovarsi a tavola.'),
      ),
    ),
    el(
      'div',
      { class: 'restaurant-about-grid' },
      image
        ? el('img', {
            src: image,
            alt: copy(site, 'story_image_alt', 'Il ristorante'),
            class: 'restaurant-about-image',
            decoding: 'async',
          })
        : null,
      el(
        'div',
        { class: 'story-copy' },
        ...copy(
          site,
          'story',
          'Per conoscere la nostra cucina e organizzare la tua visita, contattaci.',
        )
          .split(/\n\s*\n/)
          .map((text) => el('p', {}, text)),
        el('a', { href: '/menu', class: 'button primary' }, 'Esplora il menu'),
      ),
    ),
    highlights.success
      ? el(
          'div',
          { class: 'restaurant-about-values' },
          ...highlights.data.map((entry, index) =>
            el(
              'article',
              {},
              el('span', { class: 'eyebrow' }, `0${index + 1}`),
              el('h2', {}, entry.title),
              el('p', {}, entry.text),
            ),
          ),
        )
      : null,
  );
}

export function galleryPage(site: PublicSite): HTMLElement {
  const photos = z
    .array(z.object({ url: z.string(), alt: z.string() }))
    .safeParse(site.content.gallery);
  const figures = (photos.success ? photos.data : []).flatMap((photo) => {
    const src = safeImageUrl(photo.url);
    if (!src) return [];
    const open = button(
      '',
      () => {
        const popup = dialog(photo.alt, el('img', { src, alt: photo.alt, decoding: 'async' }));
        popup.classList.add('gallery-lightbox');
      },
      'quiet',
    );
    open.classList.add('gallery-image-button');
    open.setAttribute('aria-label', `Ingrandisci: ${photo.alt}`);
    open.append(el('img', { src, alt: photo.alt, loading: 'lazy', decoding: 'async' }));
    return [el('figure', {}, open, el('figcaption', {}, photo.alt))];
  });
  return el(
    'section',
    { class: 'public-section restaurant-gallery' },
    el(
      'header',
      { class: 'public-page-heading' },
      el('p', { class: 'eyebrow' }, 'A colpo d’occhio'),
      el('h1', {}, 'Gallery'),
      el(
        'p',
        { class: 'public-intro' },
        copy(site, 'gallery_intro', 'La cucina, la tavola e i nostri spazi.'),
      ),
    ),
    figures.length
      ? el('div', { class: 'gallery-grid' }, ...figures)
      : el('p', { class: 'muted' }, 'La gallery verrà aggiornata presto.'),
  );
}
