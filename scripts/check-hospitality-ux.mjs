import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async (path) => readFile(path, 'utf8');
const [home, admin, staff, restaurant, workspace, frontDesk, staffCss] = await Promise.all([
  source('apps/public/main.ts'),
  source('src/pages/admin-operations.ts'),
  source('apps/staff/main.ts'),
  source('styles/restaurant-redesign.css'),
  source('styles/workspace-redesign.css'),
  source('styles/frontdesk-v4.css'),
  source('styles/staff-app.css'),
]);
const must = (s, text, label) => assert.ok(s.includes(text), 'HOSPITALITY_UX_MISSING:' + label);
const mustNot = (s, text, label) => assert.ok(!s.includes(text), 'HOSPITALITY_UX_REGRESSION:' + label);
for (const [s, text, label] of [
  [home, "class: 'restaurant-journey-bar'", 'editorial_journey_navigation'],
  [home, "class: 'restaurant-home-content'", 'story_and_visit_group'],
  [home, 'hospitality.append(', 'dynamic_story_structure'],
  [home, 'safeImageUrl(dish.image_path)', 'actual_published_dish_images'],
  [restaurant, 'grid-template-columns: repeat(4, minmax(0, 1fr))', 'gallery_not_link_tiles'],
  [restaurant, '.restaurant-journey-bar', 'guided_guest_navigation'],
  [restaurant, '.restaurant-home-content', 'editorial_content_and_visit_split'],
  [restaurant, ':root[data-theme=\'dark\']', 'customer_dark_theme'],
  [admin, "el('div', { class: 'ops-body-grid' }, urgent, areaList)", 'priorities_before_areas'],
  [admin, 'criticalCount > 0', 'actual_live_critical_language'],
  [workspace, '.ops-body-grid', 'operations_priority_column'],
  [workspace, '.ops-summary-grid', 'numbered_performance_strip'],
  [workspace, '.workspace-context-tabs', 'accessible_workspace_navigation'],
  [frontDesk, '.host-desk-body', 'host_split_workspace'],
  [frontDesk, '.cashier-command-center', 'cash_workspace'],
  [frontDesk, '.waiter-priority-bar', 'waiter_urgency_strip'],
  [staff, "localStorage.getItem('plateform-sidebar') === 'collapsed'", 'default_expanded_sidebar'],
  [staffCss, "background: #202c2a;", 'premium_navigation_material'],
  [staffCss, '.login-layout', 'new_login_composition'],
]) must(s, text, label);
mustNot(home, 'class: \'app-home-intro public-section\'', 'legacy_shortcuts_home');
mustNot(restaurant, 'min-height: 440px', 'legacy_overlarge_empty_menu_card');
mustNot(workspace, 'background: linear-gradient(122deg, #0c1c38', 'legacy_dark_dashboard_banner');
mustNot(staffCss, 'background: #0b1831;', 'legacy_corporate_sidebar');
console.log('HOSPITALITY_UX_STRUCTURE=PASS');
