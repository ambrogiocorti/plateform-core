import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, emptyState, field, status, toast } from '../components/dom';
import { command } from './staff-context';
import type { StaffContext } from './staff-context';

const customerApprovalSchema = z.array(
  z.object({
    id: z.uuid(),
    account_id: z.uuid(),
    account_name: z.string(),
    table_id: z.uuid(),
    table_name: z.string(),
    table_number: z.number().int(),
    created_at: z.string(),
    items: z.array(
      z.object({
        dish_id: z.uuid(),
        name: z.string(),
        quantity: z.number().int(),
        step: z.number().int(),
        removed_ingredients: z.array(z.string()),
        variants: z.array(z.object({ group: z.string(), option: z.string() })),
      }),
    ),
  }),
);

function elapsedLabel(createdAt: string, acceptedAt: string | null): string {
  const target = acceptedAt ? new Date(acceptedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((target - new Date(createdAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60} min`;
}

export async function notificationsPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venue)
    return emptyState('Nessuna sede', 'Verifica le assegnazioni del tuo account.');
  const notifications = await readRows(
    'notifications',
    z.object({
      id: z.uuid(),
      category: z.string(),
      title: z.string(),
      priority: z.string(),
      status: z.string(),
      created_at: z.string(),
      resource_type: z.string(),
      resource_id: z.uuid(),
    }),
    context.venue.id,
    { status: ['NEW', 'ACKNOWLEDGED'] },
  );
  const active = notifications.filter((entry) => !['RESOLVED', 'EXPIRED'].includes(entry.status));
  const view = el('div', { class: 'stack' });
  for (const notification of active.sort((a, b) => b.created_at.localeCompare(a.created_at)))
    view.append(
      el(
        'article',
        { class: 'card stack' },
        el(
          'div',
          { class: 'row between' },
          el('h2', {}, notification.title),
          status(notification.status),
        ),
        el('p', { class: 'muted' }, new Date(notification.created_at).toLocaleString('it-IT')),
        notification.resource_type === 'accounts'
          ? button(
              'Apri conto',
              () => context.navigate(`/conti/${notification.resource_id}`),
              'secondary',
            )
          : null,
        notification.resource_type === 'cash_reconciliation_requests'
          ? button('Apri quadrature', () => context.navigate('/cassa'), 'secondary')
          : null,
        notification.resource_type === 'customer_order_requests'
          ? el(
              'p',
              { class: 'muted' },
              'La richiesta è gestibile qui sotto dal cameriere responsabile.',
            )
          : null,
        button(
          notification.status === 'NEW' ? 'Presa visione' : 'Segna risolta',
          async () => {
            await command('transition_notification', {
              p_notification: notification.id,
              p_status: notification.status === 'NEW' ? 'ACKNOWLEDGED' : 'RESOLVED',
            });
            context.navigate('/notifiche');
          },
          'secondary',
        ),
      ),
    );
  if (!active.length)
    view.append(emptyState('Tutto in ordine', 'Non ci sono notifiche da prendere in carico.'));

  if (context.profile.role === 'WAITER') {
    const [calls, tables, approvals] = await Promise.all([
      readRows(
        'waiter_calls',
        z.object({
          id: z.uuid(),
          account_id: z.uuid(),
          table_id: z.uuid(),
          kind: z.string(),
          status: z.string(),
          created_at: z.string(),
          accepted_at: z.string().nullable(),
          completed_at: z.string().nullable(),
        }),
        context.venue.id,
      ),
      readRows(
        'tables',
        z.object({ id: z.uuid(), number: z.number().int(), name: z.string() }),
        context.venue.id,
      ),
      rpc(
        'get_customer_order_approval_workspace',
        { p_venue: context.venue.id },
        customerApprovalSchema,
      ),
    ]);
    const tableById = new Map(tables.map((table) => [table.id, table]));

    for (const approval of approvals) {
      const approve = async (accepted: boolean, reason: string | null) => {
        await rpc(
          'resolve_customer_order',
          { p_request: approval.id, p_approve: accepted, p_reason: reason },
          z.object({ status: z.string(), order_id: z.uuid().nullable() }),
        );
        toast(accepted ? 'Ordine cliente approvato.' : 'Richiesta cliente rifiutata.');
        context.navigate('/notifiche');
      };
      const actions = el(
        'div',
        { class: 'row' },
        button('Approva ordine', () => approve(true, null)),
        button(
          'Rifiuta',
          () => {
            const reason = field('Motivo per il cliente', 'reason');
            reason.input.required = true;
            reason.input.minLength = 3;
            const reject = dialog('Rifiuta richiesta', reason.root);
            reject.append(
              button('Conferma rifiuto', async () => {
                if (!reason.input.reportValidity()) return;
                await approve(false, reason.input.value.trim());
                reject.close();
              }),
            );
          },
          'secondary',
        ),
      );
      view.append(
        el(
          'article',
          { class: 'card stack customer-order-approval' },
          el(
            'div',
            { class: 'row between' },
            el('h2', {}, `Ordine cliente · Tavolo ${approval.table_number}`),
            status('PENDING'),
          ),
          el('p', { class: 'muted' }, approval.account_name),
          ...approval.items.map((item) => {
            const details = [
              item.removed_ingredients.length
                ? `Senza ${item.removed_ingredients.join(', ')}`
                : null,
              item.variants.length
                ? item.variants.map((variant) => `${variant.group}: ${variant.option}`).join(' · ')
                : null,
              item.step > 1 ? `Step ${item.step}` : null,
            ].filter(Boolean);
            return el(
              'div',
              { class: 'approval-line' },
              el('strong', {}, `${item.quantity} × ${item.name}`),
              details.length ? el('span', { class: 'muted' }, details.join(' · ')) : null,
            );
          }),
          el(
            'div',
            { class: 'row' },
            button('Apri conto', () => context.navigate(`/conti/${approval.account_id}`), 'quiet'),
            el('span', { class: 'muted' }, new Date(approval.created_at).toLocaleString('it-IT')),
          ),
          actions,
        ),
      );
    }

    for (const call of calls.filter((entry) => entry.status !== 'COMPLETED')) {
      const table = tableById.get(call.table_id);
      view.append(
        el(
          'article',
          { class: 'card stack' },
          el(
            'div',
            { class: 'row between' },
            el(
              'h3',
              {},
              `${call.kind === 'BILL' ? 'Richiesta conto' : 'Chiamata cliente'} · ${table?.name ?? `Tavolo ${table?.number ?? ''}`}`,
            ),
            status(call.status),
          ),
          el(
            'p',
            { class: 'muted' },
            call.status === 'NEW'
              ? `In attesa da ${elapsedLabel(call.created_at, null)}`
              : `Presa in carico in ${elapsedLabel(call.created_at, call.accepted_at)}`,
          ),
          el(
            'div',
            { class: 'row' },
            button('Apri conto', () => context.navigate(`/conti/${call.account_id}`), 'secondary'),
            button(call.status === 'NEW' ? 'Accetta chiamata' : 'Chiamata completata', async () => {
              await command('transition_waiter_call', {
                p_call: call.id,
                p_complete: call.status === 'ACCEPTED',
              });
              context.navigate('/notifiche');
            }),
          ),
        ),
      );
    }
  }
  return view;
}
