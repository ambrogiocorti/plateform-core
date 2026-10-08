import { z } from 'zod';
import { rpc } from '../api/client';
import { floorSchema, floorView, tableLabel, type FloorTable } from '../components/floor-view';
import { button, dialog, el, emptyState, status } from '../components/dom';
import type { StaffContext } from './staff-context';
import { command } from './staff-context';
import { environment } from '../config/environment';
import { openAccountCreation } from './account-create';

export async function floorPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venue)
    return emptyState(
      'Nessuna sede assegnata',
      'Contatta l’amministratore per configurare l’accesso alla sede.',
    );
  const data = await rpc('get_floor_workspace', { p_venue: context.venue.id }, floorSchema);
  const tables = data.tables;
  const open = (table: FloorTable): void => {
    const detail = dialog(
      `${table.name} · ${table.seats} coperti`,
      status(tableLabel(data, table)),
    );
    detail.append(
      button(
        'QR del tavolo',
        async () => {
          const { toDataURL } = await import('qrcode');
          const url = new URL(`/tavolo/${table.public_table_id}`, environment().publicBaseUrl).href;
          const source = await toDataURL(url, {
            width: 360,
            margin: 2,
            errorCorrectionLevel: 'M',
          });
          dialog(
            `QR · ${table.name}`,
            el('img', { src: source, alt: `QR per ${table.name}` }),
            el('a', { href: url, target: '_blank', rel: 'noopener' }, 'Apri la pagina del tavolo'),
            el(
              'a',
              {
                href: source,
                download: `plateform-tavolo-${table.number}.png`,
                class: 'button secondary',
              },
              'Scarica QR',
            ),
          );
        },
        'secondary',
      ),
    );
    if (context.profile.role === 'WAITER' && table.can_open_account) {
      detail.append(
        button('Apri un conto', () => {
          detail.close();
          openAccountCreation(context, table);
        }),
      );
    }
    if (['ADMIN', 'HOST', 'WAITER'].includes(context.profile.role))
      detail.append(
        button(
          'Imposta il tavolo disponibile',
          async () => {
            await command('set_table_available', { p_table: table.id });
            detail.close();
            context.navigate('/sala');
          },
          'secondary',
        ),
      );
    if (['ADMIN', 'HOST'].includes(context.profile.role)) {
      const selectTarget = (title: string, action: (target: string) => Promise<void>) => {
        const selector = el(
          'select',
          {},
          ...tables
            .filter((other) => other.id !== table.id)
            .map((other) =>
              el('option', { value: other.id }, `${other.name} · ${other.seats} posti`),
            ),
        );
        const popup = dialog(title, el('label', {}, 'Tavolo di destinazione', selector));
        popup.append(
          button('Conferma', async () => {
            if (!selector.value) return;
            await action(selector.value);
            popup.close();
            detail.close();
            context.navigate('/sala');
          }),
        );
      };
      detail.append(
        button(
          'Sposta gruppo',
          () =>
            selectTarget(`Sposta ${table.name} e i suoi ospiti`, async (target) => {
              await command('move_table', { p_from: table.id, p_to: target, p_confirm: true });
            }),
          'secondary',
        ),
        button(
          'Unisci un tavolo',
          () =>
            selectTarget(`Unisci a ${table.name}`, async (target) => {
              await rpc('merge_tables', { p_primary: table.id, p_secondary: target }, z.uuid());
            }),
          'secondary',
        ),
        button(
          'Separa tavoli',
          async () => {
            await command('split_tables', { p_primary: table.id });
            detail.close();
            context.navigate('/sala');
          },
          'secondary',
        ),
      );
      if (context.profile.role === 'ADMIN')
        detail.append(
          button(
            'Configura tavolo unibile',
            () =>
              selectTarget(`Consenti suggerimenti di unione con ${table.name}`, async (target) => {
                await command('configure_table_join', {
                  p_first: table.id,
                  p_second: target,
                  p_enabled: true,
                });
              }),
            'quiet',
          ),
        );
    }
    if (['ADMIN', 'WAITER', 'CASHIER'].includes(context.profile.role))
      detail.append(
        button(
          'Visualizza i conti',
          () => {
            detail.close();
            context.navigate(`/conti?tavolo=${table.id}`);
          },
          'secondary',
        ),
      );
  };
  const view = floorView(data, open);
  const target = new URLSearchParams(location.search).get('tavolo');
  const selected = tables.find((table) => table.id === target);
  if (selected) open(selected);
  return view;
}
