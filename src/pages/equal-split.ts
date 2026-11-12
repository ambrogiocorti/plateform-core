import { z } from 'zod';
import { rpc } from '../api/client';
import { button, dialog, el, field, status, toast } from '../components/dom';
import { formatMoney } from '../services/money';
import type { Account } from '../types/accounts';
import { paymentDialog } from './account-payments';
import type { StaffContext } from './staff-context';
export const equalPlanSchema = z.object({
  id: z.uuid(),
  parts: z.number().int(),
  total_cents: z.number().int(),
  status: z.enum(['ACTIVE', 'OBSOLETE', 'COMPLETED']),
  shares: z.array(
    z.object({
      id: z.uuid(),
      ordinal: z.number().int(),
      amount_cents: z.number().int(),
      status: z.string(),
      payment_id: z.uuid().nullable(),
    }),
  ),
});
export function equalSplitSection(
  context: StaffContext,
  account: Account,
  plan: z.infer<typeof equalPlanSchema> | null,
): HTMLElement {
  const view = el('section', { class: 'card stack' }, el('h2', {}, 'Divisione equa'));
  if (account.status !== 'CLOSED')
    view.append(
      button(
        'Dividi il residuo in quote uguali',
        () => {
          const parts = field('Numero quote', 'parts', 'number', '2');
          parts.input.min = '2';
          parts.input.max = '1000';
          parts.input.required = true;
          const popup = dialog(
            'Divisione equa',
            parts.root,
            el(
              'p',
              {},
              'Le quote vengono calcolate e conservate dal server, compresi gli eventuali centesimi di differenza.',
            ),
          );
          const key = crypto.randomUUID();
          popup.append(
            button('Calcola quote', async () => {
              if (!parts.input.reportValidity()) return;
              await rpc(
                'create_equal_split',
                {
                  p_account: account.id,
                  p_parts: Number(parts.input.value),
                  p_version: account.version,
                  p_key: key,
                },
                equalPlanSchema,
              );
              popup.close();
              toast('Quote create.');
              await context.refresh?.();
            }),
          );
        },
        'secondary',
      ),
    );
  if (plan) {
    view.append(
      status(plan.status),
      el('p', {}, `${formatMoney(plan.total_cents)} · ${plan.parts} quote`),
    );
    for (const share of plan.shares)
      view.append(
        el(
          'div',
          { class: 'configuration-row' },
          el('strong', {}, `Quota ${share.ordinal} · ${formatMoney(share.amount_cents)}`),
          status(share.status),
          plan.status === 'ACTIVE' && share.status === 'UNPAID' && share.amount_cents > 0
            ? button(
                'Paga quota',
                () => paymentDialog(context, account.id, share.amount_cents, [], share.id),
                'secondary',
              )
            : null,
        ),
      );
  } else view.append(el('p', { class: 'muted' }, 'Crea un piano per incassare le singole quote.'));
  return view;
}
