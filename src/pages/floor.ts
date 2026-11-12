import { z } from 'zod';
import { rpc } from '../api/client';
import {
  floorSchema,
  floorView,
  tableGroup,
  tableGroupLabel,
  tableLabel,
  type FloorTable,
} from '../components/floor-view';
import { button, dialog, el, emptyState, status, toast } from '../components/dom';
import type { StaffContext } from './staff-context';
import { command } from './staff-context';
import { environment } from '../config/environment';
import { publicAppUrl } from '../services/public-site';
import { openAccountCreation } from './account-create';

export async function floorPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venue)
    return emptyState(
      'Nessuna sede assegnata',
      'Contatta l’amministratore per configurare l’accesso alla sede.',
    );
  const data = await rpc('get_floor_workspace', { p_venue: context.venue.id }, floorSchema);
  const tables = data.tables;
  const open = (selected: FloorTable): void => {
    const group = tableGroup(tables, selected);
    const table = group[0]!;
    const seats = group.reduce((total, member) => total + member.seats, 0);
    const covers = group.reduce((total, member) => total + member.covers, 0);
    const openAccounts = group.reduce((total, member) => total + member.open_accounts, 0);
    const detail = dialog(
      group.length > 1
        ? `${tableGroupLabel(group)} · ${seats} posti`
        : `${table.name} · ${table.seats} coperti`,
      status(tableLabel(data, table)),
    );
    detail.classList.add('table-detail-dialog');
    detail.append(
      el(
        'section',
        { class: 'table-detail-summary' },
        el('div', {}, el('span', {}, 'Capienza'), el('strong', {}, `${seats} posti`)),
        el('div', {}, el('span', {}, 'Ospiti'), el('strong', {}, String(covers))),
        el('div', {}, el('span', {}, 'Conti aperti'), el('strong', {}, String(openAccounts))),
      ),
    );
    if (group.length > 1)
      detail.append(
        el(
          'section',
          { class: 'table-group-summary' },
          el('h3', {}, 'Tavoli uniti'),
          el('p', {}, group.map((member) => member.name).join(' + ')),
          el(
            'p',
            { class: 'muted' },
            `Tavolo principale: ${table.name}. Puoi gestire il gruppo da ogni tavolo che ne fa parte.`,
          ),
        ),
      );
    if (context.profile.role === 'ADMIN')
      detail.append(
        button(
          'Modifica posizione e posti',
          () => {
            detail.close();
            context.navigate(`/editor?layout=${table.layout_id}&tavolo=${table.id}`);
          },
          'secondary',
        ),
      );
    detail.append(
      button(
        'QR del tavolo',
        async () => {
          const { toDataURL } = await import('qrcode');
          const url = publicAppUrl(`/tavolo/${table.public_table_id}`, environment().publicBaseUrl);
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
    if (
      ['ADMIN', 'HOST', 'WAITER'].includes(context.profile.role) &&
      table.technical_status !== 'AVAILABLE' &&
      openAccounts === 0
    )
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
      const selectTarget = (
        title: string,
        action: (target: string) => Promise<void>,
        operation: 'move' | 'merge' | 'configure',
        successMessage: string,
      ) => {
        const targets = tables.filter(
          (other) =>
            !group.some((member) => member.id === other.id) &&
            (operation === 'move' || other.layout_id === table.layout_id) &&
            other.technical_status === 'AVAILABLE' &&
            !other.primary_table_id &&
            (operation !== 'merge' ||
              !tables.some((member) => member.primary_table_id === other.id)),
        );
        const selector = el(
          'select',
          {},
          ...targets.map((other) => {
            const targetGroup = tableGroup(tables, other);
            const capacity = targetGroup.reduce((total, member) => total + member.seats, 0);
            return el(
              'option',
              { value: other.id },
              `${targetGroup.length > 1 ? tableGroupLabel(targetGroup) : other.name} · ${capacity} posti`,
            );
          }),
        );
        const popup = dialog(
          title,
          el(
            'p',
            { class: 'muted' },
            operation === 'merge'
              ? 'Il gruppo sarà indicato nella pianta con un collegamento blu e nell’elenco con i numeri dei tavoli.'
              : 'Seleziona un tavolo disponibile per completare l’operazione.',
          ),
          el('label', {}, 'Tavolo di destinazione', selector),
        );
        const confirm = button('Conferma', async () => {
          if (!selector.value) return;
          await action(selector.value);
          popup.close();
          detail.close();
          context.navigate('/sala');
          toast(successMessage);
        });
        if (!targets.length) {
          selector.disabled = true;
          confirm.disabled = true;
          popup.append(
            emptyState(
              'Nessun tavolo disponibile',
              operation === 'merge'
                ? 'Servono tavoli liberi della stessa pianta che non appartengano già a un altro gruppo.'
                : 'Non ci sono altri tavoli liberi compatibili con questa operazione.',
            ),
          );
        }
        popup.append(confirm);
      };
      if (covers > 0 || openAccounts > 0)
        detail.append(
          button(
            'Sposta gruppo',
            () =>
              selectTarget(
                `Sposta ${table.name} e i suoi ospiti`,
                async (target) => {
                  await command('move_table', { p_from: table.id, p_to: target, p_confirm: true });
                },
                'move',
                'Gruppo spostato. La pianta è aggiornata.',
              ),
            'secondary',
          ),
        );
      detail.append(
        button(
          'Unisci un tavolo',
          () =>
            selectTarget(
              `Unisci a ${table.name}`,
              async (target) => {
                await rpc('merge_tables', { p_primary: table.id, p_secondary: target }, z.uuid());
              },
              'merge',
              'Tavoli uniti. Il gruppo è evidenziato nella pianta.',
            ),
          'secondary',
        ),
      );
      if (group.length > 1)
        detail.append(
          button(
            'Separa tavoli',
            async () => {
              await command('split_tables', { p_primary: table.id });
              detail.close();
              context.navigate('/sala');
              toast('Tavoli separati. Ogni tavolo è di nuovo indipendente.');
            },
            'secondary',
          ),
        );
      if (context.profile.role === 'ADMIN')
        detail.append(
          button(
            'Configura tavolo unibile',
            () =>
              selectTarget(
                `Consenti suggerimenti di unione con ${table.name}`,
                async (target) => {
                  await command('configure_table_join', {
                    p_first: table.id,
                    p_second: target,
                    p_enabled: true,
                  });
                },
                'configure',
                'Unione disponibile per i suggerimenti di prenotazione.',
              ),
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
