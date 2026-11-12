import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async (path) => readFile(path, 'utf8');
const [home, admin, staff, restaurant, frontDesk, staffCss, newWorkspace, operations, tokens] =
  await Promise.all([
    source('apps/public/main.ts'),
    source('src/pages/admin-operations.ts'),
    source('apps/staff/main.ts'),
    source('styles/restaurant-redesign.css'),
    source('styles/frontdesk-v4.css'),
    source('styles/staff-app.css'),
    source('styles/workspace-v5.css'),
    source('styles/operations.css'),
    source('styles/tokens.css'),
  ]);
const must = (s, text, label) => assert.ok(s.includes(text), 'HOSPITALITY_UX_MISSING:' + label);
const mustNot = (s, text, label) =>
  assert.ok(!s.includes(text), 'HOSPITALITY_UX_REGRESSION:' + label);
for (const [s, text, label] of [
  [home, "class: 'restaurant-journey-bar'", 'editorial_journey_navigation'],
  [home, "class: 'restaurant-home-content'", 'story_and_visit_group'],
  [home, 'hospitality.append(', 'dynamic_story_structure'],
  [home, 'safeImageUrl(dish.image_path)', 'actual_published_dish_images'],
  [restaurant, 'grid-template-columns: repeat(4, minmax(0, 1fr))', 'gallery_not_link_tiles'],
  [restaurant, '.restaurant-journey-bar', 'guided_guest_navigation'],
  [restaurant, '.restaurant-home-content', 'editorial_content_and_visit_split'],
  [restaurant, ":root[data-theme='dark']", 'customer_dark_theme'],
  [admin, "el('div', { class: 'ops-body-grid' }, areaList, urgent)", 'area_first_action_board'],
  [admin, 'criticalCount > 0', 'actual_live_critical_language'],
  [operations, '.ops-body-grid', 'operations_priority_column'],
  [operations, '.ops-summary-grid', 'actionable_metric_tiles'],
  [newWorkspace, '.workspace-directory', 'accessible_workspace_directory'],
  [staff, "class: 'primary-navigation'", 'reduced_primary_navigation'],
  [staff, 'primaryNavigation(profile.role, links)', 'role_aware_navigation'],
  [staff, "classList.add('workspace-directory')", 'navigation_drawer'],
  [frontDesk, '.host-desk-body', 'host_split_workspace'],
  [frontDesk, '.cashier-command-center', 'cash_workspace'],
  [frontDesk, '.waiter-priority-bar', 'waiter_urgency_strip'],
  [
    staff,
    "localStorage.getItem('plateform-sidebar') === 'collapsed'",
    'explicit_compact_sidebar_preference',
  ],
  [newWorkspace, '--workspace-rail: var(--pf-surface);', 'shared_navigation_surface'],
  [tokens, '--pf-blue: #245edb;', 'platform_blue_accent'],
  [newWorkspace, "url('../assets/plateform/mark.svg')", 'scalable_plateform_emblem'],
  [staffCss, '.login-layout', 'existing_login_contract'],
  [staff, 'loginPage(async () => {', 'login_entry_still_available'],
])
  must(s, text, label);
mustNot(home, "class: 'app-home-intro public-section'", 'legacy_shortcuts_home');
mustNot(restaurant, 'min-height: 440px', 'legacy_overlarge_empty_menu_card');
mustNot(staff, "class: 'workspace-context-tabs'", 'redundant_second_navigation_removed');
mustNot(admin, "el('h1', {}, 'Panoramica del servizio')", 'duplicate_dashboard_heading_removed');
console.log('HOSPITALITY_UX_STRUCTURE=PASS');
