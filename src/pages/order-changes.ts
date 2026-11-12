import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, field, status, toast } from '../components/dom';
import type { StaffContext } from './staff-context';
import type { accountOrderSchema } from '../types/accounts';
import { orderDialog } from './accounts';
export function orderCorrectionButton(
  context: StaffContext,
  account: string,
  order: z.infer<typeof accountOrderSchema>,
): HTMLElement | null {
  if (
    !['ADMIN', 'WAITER'].includes(context.profile.role) ||
    order.version === undefined ||
    order.status === 'CANCELLED'
  )
    return null;
  return button(
    context.profile.role === 'ADMIN' ? 'Correggi comanda' : 'Richiedi modifica',
    () => {
      const selections = order.items
        .filter((i) => i.status !== 'CANCELLED')
        .map((i) => {
          const input = el('input', { type: 'checkbox' });
          input.checked = true;
          return {
            id: i.id,
            input,
            root: el('label', {}, input, `${i.quantity} × ${i.dish_name}`),
          };
        });
      const reason = field('Motivo', 'reason');
      reason.input.required = true;
      reason.input.minLength = 3;
      const popup = dialog(
        'Modifica o annullamento',
        ...selections.map((s) => s.root),
        reason.root,
        el(
          'p',
          {},
          'I prodotti già saldati richiedono una rettifica del pagamento. I piatti già preparati non vengono reinseriti nelle porzioni disponibili.',
        ),
      );
      const key = crypto.randomUUID();
      async function submit(lines: unknown[]): Promise<void> {
        const ids = selections.filter((s) => s.input.checked).map((s) => s.id);
        if (!ids.length || !reason.input.reportValidity()) {
          toast('Seleziona i prodotti e inserisci il motivo.', true);
          return;
        }
        if (context.profile.role === 'ADMIN') {
          await rpc(
            'modify_order',
            {
              p_order: order.id,
              p_version: order.version,
              p_item_ids: ids,
              p_replacements: lines,
              p_reason: reason.input.value,
              p_key: key,
            },
            z.record(z.string(), z.unknown()),
          );
        } else
          await rpc(
            'request_order_change',
            {
              p_order: order.id,
              p_kind: lines.length ? 'MODIFICATION' : 'CANCELLATION',
              p_payload: { item_ids: ids, replacement_lines: lines },
              p_reason: reason.input.value,
              p_version: order.version,
              p_key: key,
            },
            z.record(z.string(), z.unknown()),
          );
        popup.close();
        toast(
          context.profile.role === 'ADMIN' ? 'Comanda corretta.' : 'Richiesta inviata all’Admin.',
        );
        await context.refresh?.();
      }
      popup.append(
        button('Annulla prodotti selezionati', () => submit([]), 'secondary'),
        button('Sostituisci prodotti', async () => {
          if (!reason.input.reportValidity()) return;
          await orderDialog(context, account, 0, submit);
        }),
      );
    },
    'secondary',
  );
}
export async function orderChangesPage(context: StaffContext): Promise<HTMLElement> {
  const rows = await readRows(
    'order_change_requests',
    z.object({
      id: z.uuid(),
      kind: z.string(),
      reason: z.string(),
      order_id: z.uuid(),
      status: z.string(),
      created_at: z.string(),
    }),
    context.venue?.id,
    { status: 'PENDING' },
  );
  const view = el('div', { class: 'stack' });
  for (const row of rows)
    view.append(
      el(
        'section',
        { class: 'card stack' },
        el(
          'h2',
          {},
          row.kind === 'RETURN_CANCELLATION' ? 'Annullamento piatto reso' : 'Modifica comanda',
        ),
        el('p', {}, row.reason),
        status(row.status),
        button('Apri decisione', () => {
          const reason = field('Motivo decisione', 'reason');
          reason.input.required = true;
          reason.input.minLength = 3;
          const popup = dialog('Autorizzazione comanda', reason.root);
          const key = crypto.randomUUID();
          for (const approved of [true, false])
            popup.append(
              button(
                approved ? 'Approva e applica' : 'Rifiuta',
                async () => {
                  if (!reason.input.reportValidity()) return;
                  await rpc(
                    'resolve_order_change',
                    {
                      p_request: row.id,
                      p_approve: approved,
                      p_reason: reason.input.value,
                      p_key: key,
                    },
                    z.record(z.string(), z.unknown()),
                  );
                  popup.close();
                  await context.refresh?.();
                },
                approved ? 'primary' : 'secondary',
              ),
            );
        }),
      ),
    );
  if (!rows.length) view.append(el('p', {}, 'Nessuna modifica comanda da autorizzare.'));
  return view;
}
