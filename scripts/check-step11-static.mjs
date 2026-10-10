import { readFile } from 'node:fs/promises';

const read = async (path) => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
const requireText = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`STEP11_STATIC_FAILED:${label}`);
};

const [
  branding,
  publicMain,
  publicCss,
  publicVite,
  staffVite,
  staffHtml,
  hosting,
  telemetryEdge,
  publicSiteService,
  supabaseConfig,
] = await Promise.all([
  read('src/pages/branding.ts'),
  read('apps/public/main.ts'),
  read('styles/public.css'),
  read('vite.public.config.ts'),
  read('vite.staff.config.ts'),
  read('apps/staff/index.html'),
  read('hosting/README.md'),
  read('supabase/functions/public-telemetry/index.ts'),
  read('src/services/public-site.ts'),
  read('supabase/config.toml'),
]);

for (const [needle, label] of [
  ["'hero_image_url'", 'admin_hero_image_url'],
  ["'hero_image_alt'", 'admin_hero_image_alt'],
  ["'favicon_url'", 'admin_favicon'],
  ['pictures: GalleryPicture[]', 'admin_gallery_objects'],
  ['brand.font_heading = headingFont.value', 'admin_heading_font'],
  ['brand.font_body = bodyFont.value', 'admin_body_font'],
  ['brand.layout = layout.value', 'admin_layout'],
  ['brand.dark_mode = darkMode.checked', 'admin_dark_mode'],
  ['content.sections = Object.fromEntries', 'admin_section_visibility'],
  ["['seo_title', 'Titolo SEO']", 'admin_seo_title'],
  ["['seo_description', 'Descrizione SEO']", 'admin_seo_description'],
])
  requireText(branding, needle, label);

for (const [needle, label] of [
  ["textValue(site.branding, 'accent_color')", 'public_accent_color'],
  ["textValue(site.branding, 'background_color')", 'public_background_color'],
  ["textValue(site.branding, 'font_heading')", 'public_heading_font'],
  ["textValue(site.branding, 'font_body')", 'public_body_font'],
  ["textValue(site.branding, 'layout', 'EDITORIAL')", 'public_layout'],
  ['safeImageUrl(site.branding.favicon_url)', 'public_favicon'],
  ["if (icon) icon.href = '/icon.svg'", 'public_removed_favicon_resets'],
  ['document.documentElement.style.removeProperty(token)', 'public_brand_tokens_reset'],
  [
    'else document.head.querySelector(\'meta[property="og:image"]\')?.remove()',
    'public_og_image_clears',
  ],
  ['safeImageUrl(site.content.hero_image_url)', 'public_hero_image'],
  ['applyMetadata(site, venue)', 'public_metadata'],
  ["sectionEnabled(site, 'gallery')", 'public_sections'],
  ["tabindex: '-1'", 'public_main_focus_target'],
  ['focus({ preventScroll: true })', 'public_route_focus'],
])
  requireText(publicMain, needle, label);

for (const [needle, label] of [
  ['resolveBookingVenue(site, location.pathname, location.search)', 'bookable_venue_selection'],
  ["venueAwarePath('/prenota'", 'venue_context_booking'],
  ['public-menu-toggle', 'mobile_navigation'],
  ['restaurant-structured-data', 'structured_data'],
  ['noindex,nofollow', 'customer_noindex'],
  ['readableInk(accent)', 'accessible_accent_ink'],
  ['const accent = safeAccent(', 'accessible_accent_contrast'],
  [
    "safePublicLink(textValue(site.contact, 'instagram'), window.location.origin)",
    'safe_social_links',
  ],
  [
    "safePublicLink(textValue(site.content, 'privacy_url'), window.location.origin)",
    'safe_privacy_link',
  ],
  [
    "safeBackground(textValue(site.branding, 'background_color'), darkMode)",
    'accessible_background',
  ],
  ['observePublicPerformance', 'public_performance_observability'],
  ['recordPublicPageView', 'public_page_telemetry'],
  ['!isClientSidePublicPath(target.pathname)', 'non_public_path_does_not_intercept_staff'],
  ['safeRecoveredPublicRoute(storedRoute, location.origin)', 'static_404_recovery_is_public_only'],
  ['if (invalidVenueContext)', 'invalid_venue_context_is_not_indexed'],
  ['const entry = venue;', 'venue_details_respect_conflicting_selector_denial'],
  ['releasePublicObservers();', 'failed_site_closes_observers'],
  ['failClosedPublicMetadata();', 'failed_site_never_stays_indexable'],
  [
    'if (expectedRevision === revision) failed(error)',
    'stale_navigation_errors_do_not_replace_new_page',
  ],
  [
    "!location.pathname.startsWith('/tavolo/') && !invalidVenueContext",
    'invalid_venue_skips_seo_rpc',
  ],

  ['Il collegamento indica una sede non valida', 'stale_venue_menu_has_explicit_error'],
])
  requireText(publicMain, needle, label);

for (const [needle, label] of [
  ['PUBLIC_PAGE_VIEW', 'telemetry_page_view'],
  ['PUBLIC_PERFORMANCE', 'telemetry_performance'],
  ['rateLimit(`public-telemetry:', 'telemetry_rate_limit'],
  ['telemetry_events', 'telemetry_sink'],
  ["'/menu/:slug'", 'telemetry_accepts_named_public_menu'],
])
  requireText(telemetryEdge, needle, label);

for (const [needle, label] of [
  ['export function bookingVenue', 'booking_venue_helper'],
  ['export function venueAwarePath', 'venue_aware_path_helper'],
  ['export function canonicalPublicUrl', 'canonical_public_url_helper'],
  ['export function contrastRatio', 'contrast_ratio_helper'],
  ['export function safeAccent', 'safe_accent_helper'],
  ['export function safePublicLink', 'safe_public_link_helper'],
])
  requireText(publicSiteService, needle, label);

requireText(publicCss, "data-public-layout='modern'", 'modern_layout_css');
requireText(publicCss, "data-public-layout='classic'", 'classic_layout_css');
requireText(publicCss, '.public-nav.is-open', 'mobile_navigation_css');
requireText(publicCss, 'prefers-reduced-motion', 'reduced_motion_css');
requireText(publicVite, "JSON.stringify('public')", 'public_area_define');
requireText(publicVite, "outDir: '../../dist/public'", 'public_output');
requireText(staffVite, "JSON.stringify('staff')", 'staff_area_define');
requireText(staffVite, "outDir: '../../dist/staff'", 'staff_output');
requireText(staffHtml, 'noindex,nofollow', 'staff_noindex');
requireText(hosting, 'pubblico su `/`, staff su `/staff/`', 'hosting_path_separation');
requireText(
  supabaseConfig,
  '[functions.asset-upload]\nverify_jwt = true',
  'asset_upload_jwt_deploy_config',
);
requireText(
  supabaseConfig,
  '[functions.public-telemetry]\nverify_jwt = false',
  'public_telemetry_deploy_config',
);

console.log('STEP11_STATIC_GATE=PASSED');
