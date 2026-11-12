import { z } from 'zod';
import { rpc } from '../api/client';
import { button, el, status, toast } from '../components/dom';
import { stepUp } from '../auth/step-up';
import type { StaffContext } from './staff-context';

const deviceSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  platform: z.string(),
  venue_id: z.uuid(),
  venue_name: z.string(),
  user_id: z.uuid(),
  user_name: z.string(),
  user_role: z.string(),
  user_active: z.boolean(),
  assigned_role_or_station: z.string().nullable(),
  app_version: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  last_sync_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  online: z.boolean(),
  current: z.boolean(),
  can_revoke: z.boolean(),
});
const workspaceSchema = z.object({ devices: z.array(deviceSchema) });
type Device = z.infer<typeof deviceSchema>;

const dateLabel = (value: string | null) =>
  value ? new Date(value).toLocaleString('it-IT') : 'mai';

function deviceCard(device: Device, onRevoked: () => Promise<void>): HTMLElement {
  const card = el(
    'article',
    { class: 'card stack' },
    el(
      'div',
      { class: 'row between' },
      el(
        'div',
        {},
        el('h2', {}, device.display_name),
        el('p', { class: 'muted' }, device.platform),
      ),
      status(device.revoked_at ? 'REVOCATO' : device.online ? 'ONLINE' : 'OFFLINE'),
    ),
    el(
      'p',
      {},
      `${device.user_name} · ${device.user_role}${device.user_active ? '' : ' · utente disattivato'}`,
    ),
    el(
      'p',
      { class: 'muted' },
      `${device.venue_name} · ${device.assigned_role_or_station ?? 'Nessuna assegnazione'}`,
    ),
    el(
      'p',
      { class: 'muted' },
      `App ${device.app_version ?? 'versione non disponibile'} · ultimo contatto ${dateLabel(device.last_seen_at)} · ultimo sync ${dateLabel(device.last_sync_at)}`,
    ),
  );
  if (device.current) card.append(status('QUESTO DISPOSITIVO'));
  if (!device.revoked_at && device.can_revoke)
    card.append(
      button(
        'Revoca dispositivo',
        async () => {
          const grant = await stepUp('DEVICE_REVOKE', device.id);
          await rpc('revoke_device', { p_device: device.id, p_grant: grant }, z.null());
          toast('Dispositivo revocato. Sessioni e autorizzazioni offline collegate invalidate.');
          if (device.current) location.reload();
          else await onRevoked();
        },
        'danger',
      ),
    );
  return card;
}

export async function devicesPage(context: StaffContext): Promise<HTMLElement> {
  const canSeeAll = context.profile.scope === 'CHAIN' || context.profile.role === 'SUPER_ADMIN';
  const root = el(
    'section',
    { class: 'stack' },
    el('h1', {}, 'Device Management'),
    el(
      'p',
      { class: 'muted' },
      'Controlla dispositivi registrati, stato online, versione applicativa, ultimo sync e revoche operative.',
    ),
  );
  const venue = el(
    'select',
    { 'aria-label': 'Filtra dispositivi per sede' },
    canSeeAll ? el('option', { value: '' }, 'Tutte le sedi autorizzate') : null,
    ...context.venues.map((item) => el('option', { value: item.id }, item.name)),
  ) as HTMLSelectElement;
  if (!canSeeAll && context.venue) venue.value = context.venue.id;
  const list = el('div', { class: 'stack', 'aria-live': 'polite' });
  const summary = el('p', { class: 'muted' });
  root.append(el('label', {}, 'Sede', venue), summary, list);

  const load = async () => {
    const selectedVenue = venue.value || null;
    const data = await rpc('get_device_management', { p_venue: selectedVenue }, workspaceSchema);
    const active = data.devices.filter((device) => !device.revoked_at);
    const online = active.filter((device) => device.online).length;
    summary.textContent = `${data.devices.length} dispositivi · ${online} online · ${active.length - online} offline · ${data.devices.length - active.length} revocati`;
    list.replaceChildren(
      ...data.devices.map((device) => deviceCard(device, load)),
      ...(data.devices.length ? [] : [el('p', {}, 'Nessun dispositivo per questo ambito.')]),
    );
  };
  venue.addEventListener('change', () => void load());
  await load();
  return root;
}
