import { z } from 'zod';
import { client, readRows, rpc, safeEdgeError } from '../api/client';
import { button, el, field, toast } from '../components/dom';
import type { StaffContext } from './staff-context';
import { safeImageUrl } from '../config/environment';
import { safeAccent, safeBackground } from '../services/public-site';

type Bucket = 'branding' | 'dishes' | 'gallery' | 'documents';
export function assetUploadControl(
  bucket: Bucket,
  resource: string | null,
  venue: string | null,
  purpose: string,
  onUploaded: (url: string | null) => void,
): HTMLElement {
  // Several uploads share a page: each control is named after what it uploads.
  const input = el('input', {
    type: 'file',
    accept: bucket === 'documents' ? '.pdf' : 'image/png,image/jpeg,image/webp',
    'aria-label': `File: ${purpose}`,
  });
  let key = crypto.randomUUID();
  input.addEventListener('change', () => {
    key = crypto.randomUUID();
  });
  const upload = button(
    'Carica file',
    async () => {
      const file = input.files?.[0];
      if (!file || file.size < 1 || file.size > 5242880) {
        toast('Scegli un file fino a 5 MB.', true);
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let start = 0; start < bytes.length; start += 8192)
        binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      const { data, error } = await client().functions.invoke('asset-upload', {
        body: {
          bucket,
          resource_id: resource,
          venue_id: venue,
          mime: file.type,
          content_base64: btoa(binary),
          idempotency_key: key,
        },
      });
      if (error) throw await safeEdgeError(error);
      const result = z.object({ id: z.uuid(), url: z.url().nullable() }).parse(data);
      onUploaded(result.url);
      toast('File caricato. Salva la configurazione per pubblicarlo.');
    },
    'secondary',
  );
  upload.setAttribute('aria-label', `Carica file: ${purpose}`);
  return el('div', { class: 'field' }, input, upload);
}

export async function brandingPage(context: StaffContext): Promise<HTMLElement> {
  if (context.profile.scope !== 'CHAIN')
    return el('p', {}, 'Il sito del brand è gestito dall’amministratore della catena.');
  const profiles = await readRows(
    'restaurant_profile',
    z.object({
      version: z.number().int(),
      branding: z.record(z.string(), z.unknown()),
      public_content: z.record(z.string(), z.unknown()),
      contact: z.record(z.string(), z.unknown()),
    }),
  );
  const profile = profiles[0];
  if (!profile) return el('p', {}, 'Completa prima la configurazione del ristorante.');
  const brand = { ...profile.branding },
    content = { ...profile.public_content },
    contact = { ...profile.contact };
  const view = el('div', { class: 'stack' }),
    inputs: { input: HTMLInputElement; target: Record<string, unknown>; key: string }[] = [];
  const section = (title: string) => {
    const node = el('section', { class: 'card stack' }, el('h2', {}, title));
    view.append(node);
    return node;
  };
  const visual = section('Identità visiva');
  for (const [key, label, fallback] of [
    ['accent_color', 'Colore principale', '#B88A55'],
    ['background_color', 'Sfondo', '#111315'],
  ] as const) {
    const control = field(label, key, 'color', String(brand[key] ?? fallback));
    visual.append(control.root);
    inputs.push({ input: control.input, target: brand, key });
  }
  const selectSetting = (
    label: string,
    key: string,
    options: readonly [string, string][],
    fallback: string,
  ) => {
    const id = `brand-${crypto.randomUUID()}`;
    const select = el(
      'select',
      { id, name: key },
      ...options.map(([value, text]) => el('option', { value }, text)),
    );
    select.value = String(brand[key] ?? fallback);
    visual.append(el('div', { class: 'field' }, el('label', { for: id }, label), select));
    return select;
  };
  const headingFont = selectSetting(
    'Font titoli',
    'font_heading',
    [
      ['SERIF', 'Serif'],
      ['SANS', 'Sans serif'],
      ['HUMANIST', 'Humanist'],
    ],
    'SERIF',
  );
  const bodyFont = selectSetting(
    'Font testo',
    'font_body',
    [
      ['SANS', 'Sans serif'],
      ['SERIF', 'Serif'],
      ['HUMANIST', 'Humanist'],
    ],
    'SANS',
  );
  const layout = selectSetting(
    'Layout',
    'layout',
    [
      ['EDITORIAL', 'Editoriale'],
      ['MODERN', 'Moderno'],
      ['CLASSIC', 'Classico'],
    ],
    'EDITORIAL',
  );
  const darkModeId = `brand-dark-${crypto.randomUUID()}`;
  const darkMode = el('input', { id: darkModeId, type: 'checkbox' });
  darkMode.checked = brand.dark_mode !== false;
  visual.append(el('label', { for: darkModeId, class: 'row' }, darkMode, 'Tema scuro'));
  const logo = field('Logo', 'logo_url', 'url', String(brand.logo_url ?? ''));
  visual.append(
    logo.root,
    assetUploadControl('branding', null, null, 'logo', (url) => {
      logo.input.value = url ?? '';
    }),
  );
  inputs.push({ input: logo.input, target: brand, key: 'logo_url' });
  const favicon = field('Favicon', 'favicon_url', 'url', String(brand.favicon_url ?? ''));
  visual.append(
    favicon.root,
    assetUploadControl('branding', null, null, 'favicon', (url) => {
      favicon.input.value = url ?? '';
    }),
  );
  inputs.push({ input: favicon.input, target: brand, key: 'favicon_url' });
  const editorial = section('Home e contenuti');
  for (const [key, label] of [
    ['hero_eyebrow', 'Sopratitolo iniziale'],
    ['hero_title', 'Titolo iniziale'],
    ['hero_subtitle', 'Introduzione'],
    ['story_title', 'Titolo della storia'],
    ['story', 'La storia del ristorante'],
    ['booking_note', 'Informazioni per chi prenota'],
    ['footer', 'Testo footer'],
  ] as const) {
    const control = field(label, key, 'text', String(content[key] ?? ''));
    editorial.append(control.root);
    inputs.push({ input: control.input, target: content, key });
  }
  const hero = field(
    'Fotografia iniziale',
    'hero_image_url',
    'url',
    String(content.hero_image_url ?? content.hero_image ?? ''),
  );
  editorial.append(
    hero.root,
    assetUploadControl('branding', null, null, 'fotografia iniziale', (url) => {
      hero.input.value = url ?? '';
    }),
  );
  inputs.push({ input: hero.input, target: content, key: 'hero_image_url' });
  const heroAlt = field(
    'Testo alternativo fotografia iniziale',
    'hero_image_alt',
    'text',
    String(content.hero_image_alt ?? ''),
  );
  editorial.append(heroAlt.root);
  inputs.push({ input: heroAlt.input, target: content, key: 'hero_image_alt' });
  type GalleryPicture = { url: string; alt: string };
  const gallery = section('Galleria fotografica'),
    pictures: GalleryPicture[] = Array.isArray(content.gallery)
      ? content.gallery.flatMap((image, index) => {
          if (typeof image === 'string')
            return [{ url: image, alt: `Fotografia del ristorante ${index + 1}` }];
          if (
            image &&
            typeof image === 'object' &&
            typeof (image as Record<string, unknown>).url === 'string' &&
            typeof (image as Record<string, unknown>).alt === 'string'
          )
            return [
              {
                url: String((image as Record<string, unknown>).url),
                alt: String((image as Record<string, unknown>).alt),
              },
            ];
          return [];
        })
      : [];
  const galleryList = el('div', { class: 'grid' });
  function renderGallery(): void {
    galleryList.replaceChildren(
      ...pictures.map((picture, index) =>
        el(
          'article',
          { class: 'card' },
          safeImageUrl(picture.url)
            ? el('img', {
                src: safeImageUrl(picture.url)!,
                alt: picture.alt,
                loading: 'lazy',
                class: 'asset-preview',
              })
            : el('p', {}, 'Indirizzo immagine non valido'),
          button(
            'Rimuovi dalla galleria',
            () => {
              pictures.splice(index, 1);
              renderGallery();
            },
            'quiet',
          ),
        ),
      ),
    );
  }
  renderGallery();
  gallery.append(
    galleryList,
    assetUploadControl('gallery', null, null, 'nuova foto della galleria', (url) => {
      if (url) {
        pictures.push({ url, alt: `Fotografia del ristorante ${pictures.length + 1}` });
        renderGallery();
      }
    }),
  );
  const visibility = section('Sezioni del sito');
  const sections =
    content.sections && typeof content.sections === 'object' && !Array.isArray(content.sections)
      ? { ...(content.sections as Record<string, unknown>) }
      : {};
  const sectionControls: { input: HTMLInputElement; key: string }[] = [];
  for (const [key, label] of [
    ['story', 'Mostra storia'],
    ['gallery', 'Mostra gallery'],
    ['venues', 'Mostra sedi'],
    ['booking', 'Mostra prenotazioni'],
    ['contacts', 'Mostra contatti'],
  ] as const) {
    const id = `section-${crypto.randomUUID()}`;
    const input = el('input', { id, type: 'checkbox' });
    input.checked = sections[key] !== false;
    visibility.append(el('label', { for: id, class: 'row' }, input, label));
    sectionControls.push({ input, key });
  }
  const seo = section('SEO e condivisione');
  for (const [key, label] of [
    ['seo_title', 'Titolo SEO'],
    ['seo_description', 'Descrizione SEO'],
  ] as const) {
    const control = field(label, key, 'text', String(content[key] ?? ''));
    seo.append(control.root);
    inputs.push({ input: control.input, target: content, key });
  }
  const contacts = section('Contatti e privacy');
  for (const [key, label, type] of [
    ['phone', 'Telefono', 'tel'],
    ['email', 'Email', 'email'],
    ['instagram', 'Instagram', 'url'],
    ['facebook', 'Facebook', 'url'],
    ['vat_number', 'Partita IVA', 'text'],
  ] as const) {
    const control = field(label, key, type, String(contact[key] ?? ''));
    contacts.append(control.root);
    inputs.push({ input: control.input, target: contact, key });
  }
  const privacy = field(
    'Indirizzo informativa privacy',
    'privacy_url',
    'url',
    String(content.privacy_url ?? ''),
  );
  contacts.append(privacy.root);
  inputs.push({ input: privacy.input, target: content, key: 'privacy_url' });
  const key = crypto.randomUUID();
  view.append(
    button('Salva sito e branding', async () => {
      if (inputs.some((entry) => !entry.input.reportValidity())) return;
      for (const entry of inputs) entry.target[entry.key] = entry.input.value;
      // Same WCAG AA rule as private.branding_contrast_valid: explain it before the server refuses.
      const background = String(
        brand.background_color || (darkMode.checked ? '#111315' : '#f4f0e8'),
      );
      if (!safeBackground(background, darkMode.checked)) {
        toast(
          darkMode.checked
            ? 'Lo sfondo è troppo chiaro per il tema scuro: il testo non sarebbe leggibile.'
            : 'Lo sfondo è troppo scuro per il tema chiaro: il testo non sarebbe leggibile.',
          true,
        );
        return;
      }
      if (brand.accent_color && !safeAccent(String(brand.accent_color), background)) {
        toast(
          'Il colore principale non ha contrasto sufficiente con lo sfondo (minimo 4,5:1): scegline uno più chiaro o più scuro.',
          true,
        );
        return;
      }
      brand.font_heading = headingFont.value;
      brand.font_body = bodyFont.value;
      brand.layout = layout.value;
      brand.dark_mode = darkMode.checked;
      content.gallery = pictures;
      content.sections = Object.fromEntries(
        sectionControls.map(({ input, key }) => [key, input.checked]),
      );
      await rpc(
        'save_brand_content',
        {
          p_version: profile.version,
          p_branding: brand,
          p_content: content,
          p_contact: contact,
          p_key: key,
        },
        z.object({ version: z.number().int() }),
      );
      toast('Sito aggiornato.');
      await context.refresh?.();
    }),
  );
  return view;
}
