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
const customerExperience = await read('styles/public-app.css');
const staffExperience = await read('styles/staff-app.css');
const staffMain = await read('apps/staff/main.ts');

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
  ["if (icon) icon.href = hrefForPublicRoute('/icon.svg')", 'public_removed_favicon_resets'],
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
  ['resolveBookingVenue(site, currentPublicPath(), location.search)', 'bookable_venue_selection'],
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
  ["!isPreview && currentPublicPath() !== '/lista-attesa/offerta'", 'preview_telemetry_disabled'],
  [
    "!isClientSidePublicPath(internalPublicPath(target.pathname, PUBLIC_BASE) ?? '')",
    'non_public_path_does_not_intercept_staff',
  ],
  [
    'safeRecoveredPublicRoute(storedRoute, location.origin, PUBLIC_BASE)',
    'static_404_recovery_is_public_only',
  ],
  ['if (invalidVenueContext)', 'invalid_venue_context_is_not_indexed'],
  ['const entry = venue;', 'venue_details_respect_conflicting_selector_denial'],
  ['releasePublicObservers();', 'failed_site_closes_observers'],
  ['failClosedPublicMetadata();', 'failed_site_never_stays_indexable'],
  [
    'if (expectedRevision === revision) failed(error)',
    'stale_navigation_errors_do_not_replace_new_page',
  ],
  [
    "currentPublicPath() !== '/lista-attesa/offerta' &&\n    !invalidVenueContext\n  ) {\n    const pathForSeo = currentPublicPath();",
    'invalid_venue_and_secret_offer_skip_seo_rpc',
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

const designSystem = await read('styles/plateform-design-system.css');
const customerPage = await read('src/pages/customer.ts');
const publishedMenu = await read('src/pages/public-menu.ts');
for (const [needle, label] of [
  ["import '../../styles/public-app.css'", 'public_design_loaded'],
  ["import '../../styles/restaurant-redesign.css'", 'public_new_structural_layout_loaded'],
  ["class: 'restaurant-welcome'", 'real_restaurant_home'],
  ["class: 'restaurant-discover'", 'real_menu_discovery'],
  ["class: 'restaurant-visit-panel'", 'visit_sidebar'],
  ["class: 'restaurant-featured-grid'", 'real_menu_highlights'],
  ["class: 'public-menu-toolbar'", 'public_menu_search'],
  ['UI 2.0 · TEST', 'public_preview_signature'],
  ["document.documentElement.style.setProperty('--pf-blue', accent)", 'brand_accent_is_dynamic'],
])
  requireText(publicMain, needle, label);
for (const [needle, label] of [
  ["@import './plateform-design-system.css'", 'shared_design_imported_public'],
  ['.app-home-heading', 'new_home_composition'],
  ['.dish-public.public-dish-card', 'photographic_dish_cards'],
  ['.public-menu-toolbar', 'search_controls'],
  ['.customer-task-nav', 'customer_navigation_layout'],
  ['.public-dish-detail', 'dish_detail_layout'],
  ['.customer-cart-row', 'cart_layout'],
  ['.public-footer', 'new_footer_layout'],
  ['@media (max-width: 520px)', 'small_mobile_layout'],
])
  requireText(customerExperience, needle, label);
for (const [needle, label] of [
  ['--pf-background: #f5f7fc', 'light_default_palette'],
  ['--pf-background: #0b1324', 'dark_palette'],
  ['.dialog', 'modal_design'],
  ['.table-wrap', 'tables_design'],
  ['.kpi-grid', 'metric_grid'],
  ['[hidden]', 'hidden_means_hidden'],
  ['prefers-reduced-motion', 'reduced_motion'],
])
  requireText(designSystem, needle, label);
for (const [needle, label] of [
  ["import '../../styles/staff-app.css'", 'staff_design_loaded'],
  ["import '../../styles/workspace-redesign.css'", 'staff_structural_redesign_loaded'],
  ["class: 'workspace-context-tabs'", 'new_role_navigation_structure'],
  ["class: 'workspace-page-heading'", 'new_workspace_heading'],
  ["class: collapsedSidebar ? 'staff-shell sidebar-collapsed'", 'staff_sidebar_toggle'],
  ['navIcon(link.path)', 'staff_icon_navigation'],
  ['NUOVA UI · TEST', 'staff_preview_signature'],
  ["localStorage.getItem('plateform-theme') ?? 'light'", 'light_default_staff'],
])
  requireText(staffMain, needle, label);
for (const [needle, label] of [
  ["@import './plateform-design-system.css'", 'shared_design_imported_staff'],
  ['.sidebar .nav-link', 'sidebar_design'],
  ['.topbar', 'toolbar_design'],
  ['.kpi-grid', 'dashboard_design'],
  ['.login-layout', 'login_redesign'],
  ['.kitchen-grid', 'kitchen_redesign'],
  ['@media (max-width: 640px)', 'mobile_staff_navigation'],
])
  requireText(staffExperience, needle, label);
for (const [needle, label] of [
  ["class: 'customer-task-nav'", 'customer_tabs_functional'],
  ["class: 'customer-hub'", 'customer_hub'],
  ["button('Aggiungi al carrello'", 'order_behavior_preserved'],
])
  requireText(customerPage, needle, label);
for (const [needle, label] of [
  ["'public-menu-search'", 'published_menu_search'],
  ["search.addEventListener('input'", 'published_menu_filter_function'],
  ['dishPath(dish.id)', 'published_dish_detail_link'],
])
  requireText(publishedMenu, needle, label);

const restaurantStructure = await read('styles/restaurant-redesign.css');
const workplaceStructure = await read('styles/workspace-redesign.css');
const adminOperations = await read('src/pages/admin-operations.ts');
const kitchenPage = await read('src/pages/kitchen.ts');
for (const [text, label] of [
  ['.restaurant-home-content', 'restaurant_real_content_columns'],
  ['.restaurant-featured-grid', 'featured_menu_tiles'],
  ['.restaurant-story-panel', 'restaurant_story_layout'],
  ['.restaurant-visit-links', 'reservation_utility_panel'],
])
  requireText(restaurantStructure, text, label);
for (const [text, label] of [
  ['.workspace-context-tabs', 'staff_contextual_navigation'],
  ['.ops-overview', 'command_center_main_panel'],
  ['.ops-body-grid', 'asymmetric_dashboard_layout'],
  ['.ops-attention-card', 'separate_priority_rail'],
  ['.ops-service-grid', 'operational_area_matrix'],
  ['.kds-filter-actions', 'kitchen_filter_controls'],
])
  requireText(workplaceStructure, text, label);
for (const [text, label] of [
  ["class: 'ops-overview'", 'dashboard_restructured'],
  ["class: 'ops-attention-card'", 'dashboard_priorities_separated'],
  ["class: 'ops-summary-grid'", 'dashboard_kpis_restructured'],
])
  requireText(adminOperations, text, label);
for (const [text, label] of [
  ["class: 'kds-workspace'", 'kds_new_workspace'],
  ["class: 'kds-filter-actions'", 'kds_operational_filters'],
  ["control.setAttribute('aria-pressed'", 'kds_filter_accessibility'],
])
  requireText(kitchenPage, text, label);

console.log('STEP11_STATIC_GATE=PASSED');
