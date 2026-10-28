import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(path, 'utf8');
const [publicCss, staffCss, baseCss, systemCss, tokens, publicMain, staffMain] = await Promise.all([
  read('styles/public.css'),
  read('styles/staff.css'),
  read('styles/base.css'),
  read('styles/plateform-design-system.css'),
  read('styles/tokens.css'),
  read('apps/public/main.ts'),
  read('apps/staff/main.ts'),
]);

function requireText(haystack, needle, label) {
  assert.ok(haystack.includes(needle), 'REPORT_AUDIT_FAILED:' + label);
}
function forbidText(haystack, needle, label) {
  assert.ok(!haystack.includes(needle), 'REPORT_AUDIT_FAILED:' + label);
}
function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
function contrast(a, b) {
  const luminance = (hex) => {
    const c = rgb(hex).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Report #1: no fixed black overlay/text on a light-themed hero.
forbidText(publicCss, 'linear-gradient(90deg, #111315ec', 'public_hero_fixed_overlay');
requireText(publicCss, 'color: var(--text)', 'public_hero_text_theme');
// Report #2: notification badge ink must follow accent contrast, not a dark hardcode.
requireText(staffCss, 'color: var(--accent-ink)', 'notification_badge_contrast');
forbidText(staffCss, 'color: #111315', 'notification_badge_hardcoded_ink');
// Report #3: form control boundaries must satisfy 3:1 non-text contrast against surfaces.
requireText(baseCss, 'var(--pf-control-border', 'base_form_boundary_token');
requireText(systemCss, '--pf-control-border: #8493aa', 'light_control_boundary');
requireText(systemCss, '--pf-control-border: #8498b0', 'dark_control_boundary');
for (const [border, background, label] of [
  ['#8493aa', '#ffffff', 'light'],
  ['#8498b0', '#152038', 'dark'],
]) {
  const ratio = contrast(border, background);
  assert.ok(
    ratio >= 3.0,
    'REPORT_AUDIT_FAILED:' + label + '_form_border_contrast=' + ratio.toFixed(2),
  );
  console.log('FORM_CONTROL_CONTRAST_' + label.toUpperCase() + '=' + ratio.toFixed(2));
}
// Report #4: room editor and operational map need semantic surfaces.
forbidText(staffCss, 'background: #202326', 'room_editor_fixed_black');
forbidText(staffCss, 'background: #171b20', 'operational_map_fixed_black');
// Report #5: the mobile navbar and title have safe constraints.
requireText(staffCss, '.sidebar-section,', 'mobile_sidebar_labels');
requireText(staffCss, 'max-width: min(65vw, 340px)', 'mobile_context_width');
// Report #6: no invisible sticky offset in waiter mobile layout.
forbidText(staffCss, 'top: 56px', 'waiter_sticky_gap');
requireText(staffCss, 'position: static', 'waiter_mobile_normal_flow');
// Additional focus + content + high contrast regressions.
forbidText(staffCss, '.operational-table:focus {\n  outline: none;', 'floor_map_keyboard_focus');
requireText(staffCss, '.operational-table:focus-visible', 'floor_map_focus_visible');
requireText(staffCss, 'stroke: var(--accent)', 'floor_map_focus_contrast');
forbidText(publicCss, '.gallery-grid:empty::before', 'content_in_css');
requireText(publicMain, 'La gallery verrà aggiornata presto.', 'empty_gallery_in_dom');
requireText(staffMain, "class: 'brand-mark'", 'logo_mark_in_markup');
forbidText(tokens, 'Inter, Segoe UI', 'unavailable_inter_font');
requireText(systemCss, '@media (forced-colors: active)', 'forced_colors_support');
for (const token of ['--pf-space-2', '--pf-text-md', '--pf-radius-md', '--pf-layer-nav']) {
  requireText(systemCss, token, 'design_token_' + token);
}
console.log('REPORT_FRONTEND_AUDIT=PASS');
