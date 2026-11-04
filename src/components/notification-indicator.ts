import { z } from 'zod';
import { rpc } from '../api/client';
import { button, dialog, el } from './dom';
import {
  enableNotificationSound,
  notificationSoundEnabled,
  playNotificationSound,
} from '../services/notification-sound';
import type { StaffContext } from '../pages/staff-context';

const ruleSchema = z.object({
  sound: z.enum(['OFF', 'GENTLE', 'DOUBLE', 'URGENT']),
  priority: z.string(),
  enabled: z.boolean(),
  badge: z.boolean(),
});
export const notificationRulesSchema = z.record(z.string(), ruleSchema);
const summarySchema = z.object({
  new_count: z.number().int(),
  badge_count: z.number().int(),
  active_count: z.number().int(),
  alerts: z.array(
    z.object({ id: z.uuid(), category: z.string(), priority: z.string(), created_at: z.string() }),
  ),
  rules: notificationRulesSchema,
});
const seenByScope = new Map<string, Set<string>>();
let refreshCurrent: (() => Promise<void>) | undefined;
export async function refreshNotificationIndicator(): Promise<void> {
  await refreshCurrent?.();
}
export function clearNotificationIndicator(): void {
  refreshCurrent = undefined;
}

function controlIcon(kind: 'bell' | 'sound'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    kind === 'bell'
      ? 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4'
      : 'M4 9v6h4l5 4V5L8 9H4z M17 9a5 5 0 0 1 0 6 M19.5 5.5a10 10 0 0 1 0 13',
  );
  svg.append(path);
  return svg;
}

export function notificationIndicator(context: StaffContext): HTMLElement {
  const scope = `${context.profile.id}:${context.venue?.id ?? ''}`,
    storage = `plateform-audio:${scope}`;
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(storage) ?? 'null');
  } catch {
    saved = null;
  }
  const stored = z
    .object({ enabled: z.boolean(), volume: z.number().min(0).max(100) })
    .safeParse(saved);
  const preferences = stored.success
    ? { ...stored.data, enabled: stored.data.enabled && notificationSoundEnabled() }
    : { enabled: false, volume: 50 };
  const label = el('span', {}, 'Notifiche'),
    badge = el('span', { class: 'notification-badge', 'aria-hidden': 'true' });
  badge.hidden = true;
  const open = button('', () => context.navigate('/notifiche'), 'quiet');
  open.append(controlIcon('bell'), label, badge);
  open.setAttribute('aria-label', 'Notifiche');
  const soundLabel = el('span', {}, preferences.enabled ? 'Audio attivo' : 'Audio disattivo');
  const sound = button(
    '',
    () => {
      const volume = el('input', {
        type: 'range',
        min: '0',
        max: '100',
        value: String(preferences.volume),
        'aria-label': 'Volume notifiche',
      });
      const popup = dialog(
        'Avvisi audio sul dispositivo',
        el(
          'p',
          {},
          'Attiva gli avvisi dopo aver verificato il volume. La preferenza vale per questo utente e questa sede.',
        ),
        el('label', {}, 'Volume', volume),
      );
      const save = () => {
        localStorage.setItem(storage, JSON.stringify(preferences));
        soundLabel.textContent = preferences.enabled ? 'Audio attivo' : 'Audio disattivo';
        sound.setAttribute('aria-label', soundLabel.textContent);
      };
      popup.append(
        button('Attiva e prova', async () => {
          await enableNotificationSound();
          preferences.enabled = true;
          preferences.volume = Number(volume.value);
          save();
          playNotificationSound('DOUBLE', preferences.volume);
        }),
        button(
          'Disattiva avvisi audio',
          () => {
            preferences.enabled = false;
            save();
            popup.close();
          },
          'secondary',
        ),
      );
      volume.addEventListener('change', () => {
        preferences.volume = Number(volume.value);
        save();
      });
    },
    'quiet',
  );
  sound.append(controlIcon('sound'), soundLabel);
  sound.setAttribute('aria-label', soundLabel.textContent);
  const root = el('div', { class: 'row notification-indicator' }, open, sound);
  refreshCurrent = async () => {
    if (!root.isConnected || !context.venue) return;
    let data: z.infer<typeof summarySchema>;
    try {
      data = await rpc('get_notification_summary', { p_venue: context.venue.id }, summarySchema);
    } catch {
      if (root.isConnected) {
        open.setAttribute('aria-label', 'Notifiche: dati da aggiornare');
        badge.textContent = '?';
        badge.hidden = false;
      }
      return;
    }
    if (!root.isConnected) return;
    badge.textContent = String(data.badge_count);
    badge.hidden = !data.badge_count;
    open.setAttribute(
      'aria-label',
      `Notifiche: ${data.new_count} da leggere, ${data.active_count} attive`,
    );
    let seen = seenByScope.get(scope);
    if (!seen) {
      seen = new Set(data.alerts.map((alert) => alert.id));
      seenByScope.set(scope, seen);
      return;
    }
    const fresh = data.alerts.filter((alert) => !seen!.has(alert.id));
    for (const alert of data.alerts) seen.add(alert.id);
    if (seen.size > 2000) seenByScope.set(scope, new Set(data.alerts.map((alert) => alert.id)));
    const audible = fresh.find((alert) => {
      const rule = data.rules[alert.category] ?? data.rules.DEFAULT;
      return !rule || (rule.enabled && rule.sound !== 'OFF');
    });
    if (audible && preferences.enabled) {
      const rule = data.rules[audible.category] ?? data.rules.DEFAULT;
      playNotificationSound(
        rule?.sound ?? (['INCIDENT', 'CRITICAL'].includes(audible.priority) ? 'URGENT' : 'GENTLE'),
        preferences.volume,
      );
    }
  };
  return root;
}
