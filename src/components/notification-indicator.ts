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
  open.append(label, badge);
  open.setAttribute('aria-label', 'Notifiche');
  const sound = button(
    preferences.enabled ? 'Audio attivo' : 'Audio disattivo',
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
        sound.textContent = preferences.enabled ? 'Audio attivo' : 'Audio disattivo';
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
