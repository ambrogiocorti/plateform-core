import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import type { Account } from '../types/accounts';
import type { StaffContext } from './staff-context';
export async function transferDialog(
  context: StaffContext,
  source: Account,
  items: { order_item_id: string; dish_name: string; selectable_quantity: number }[],
): Promise<void> {
  const accounts = await readRows(
    'accounts',
    z.object({
      id: z.uuid(),
      account_name: z.string(),
      table_id: z.uuid(),
      status: z.string(),
      version: z.number().int(),
    }),
    context.venue?.id,
  );
  const targets = accounts.filter((a) => a.id !== source.id && a.status !== 'CLOSED');
  const target = el(
    'select',
    { 'aria-label': 'Conto di destinazione' },
    el('option', { value: '' }, 'Crea conto per divisione'),
    ...targets.map((a) => el('option', { value: a.id }, a.account_name)),
  );
  const name = field('Nome nuovo conto', 'name'),
    selections = items.map((i) => {
      const q = field(`${i.dish_name} · quantità da spostare`, 'quantity', 'number', '0');
      q.input.min = '0';
      q.input.max = String(i.selectable_quantity);
      return { item: i, input: q.input, root: q.root };
    });
  const mode = el(
    'select',
    { 'aria-label': 'Operazione' },
    el('option', { value: 'ITEMS' }, 'Sposta prodotti selezionati'),
    el('option', { value: 'MERGE' }, 'Unisci il residuo dei conti'),
  );
  const popup = dialog(
    'Divisione e unione conti',
    el('label', {}, 'Destinazione', target),
    name.root,
    el('label', {}, 'Operazione', mode),
    ...selections.map((s) => s.root),
    el(
      'p',
      {},
      'Si spostano addebiti non saldati. La comanda originale resta alla cucina; pagamenti e storico mantengono il loro conto di origine.',
    ),
  );
  const key = crypto.randomUUID();
  popup.append(
    button('Conferma trasferimento', async () => {
      if (selections.some((s) => !s.input.reportValidity())) return;
      const destination = targets.find((a) => a.id === target.value);
      let result: { target_account_id: string };
      if (mode.value === 'MERGE') {
        if (!destination) {
          toast('Seleziona un conto esistente per unire.', true);
          return;
        }
        result = await rpc(
          'merge_accounts',
          {
            p_source: source.id,
            p_target: destination.id,
            p_source_version: source.version,
            p_target_version: destination.version,
            p_key: key,
          },
          z.object({ target_account_id: z.uuid() }),
        );
      } else {
        const selected = selections
          .filter((s) => Number(s.input.value) > 0)
          .map((s) => ({ item_id: s.item.order_item_id, quantity: Number(s.input.value) }));
        if (!selected.length) {
          toast('Seleziona almeno un prodotto.', true);
          return;
        }
        result = await rpc(
          'move_account_items',
          {
            p_source: source.id,
            p_target: destination?.id ?? null,
            p_name: name.input.value || null,
            p_items: selected,
            p_source_version: source.version,
            p_target_version: destination?.version ?? null,
            p_key: key,
          },
          z.object({ target_account_id: z.uuid() }),
        );
      }
      popup.close();
      toast('Trasferimento registrato.');
      context.navigate(`/conti/${result.target_account_id}`);
    }),
  );
}
