import { z } from 'zod';
import { rpc } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import { accountWorkspaceSchema } from '../types/accounts';
import type { StaffContext } from './staff-context';

export interface AccountCreationTable {
  id: string;
  name: string;
}

export function openAccountCreation(context: StaffContext, table: AccountCreationTable): void {
  const name = field('Nome conto', 'name');
  name.input.required = true;
  const covers = field('Coperti', 'covers', 'number', '2');
  covers.input.min = '1';
  covers.input.max = '1000';
  const note = field('Nota interna', 'note');
  const key = crypto.randomUUID();
  const editor = dialog(`Nuovo conto · ${table.name}`, name.root, covers.root, note.root);
  editor.append(
    button('Crea conto', async () => {
      if (!name.input.reportValidity() || !covers.input.reportValidity()) return;
      const result = await rpc(
        'create_account',
        {
          p_table: table.id,
          p_name: name.input.value,
          p_covers: Number(covers.input.value),
          p_note: note.input.value || null,
          p_key: key,
        },
        z.object({
          id: z.uuid(),
          code: z.string().optional(),
          code_available: z.boolean(),
        }),
      );
      editor.close();
      const created = dialog(
        'Conto aperto',
        el(
          'p',
          {},
          result.code
            ? 'Comunica questo codice ai clienti del conto.'
            : 'Il conto è stato creato. Rigenera il codice se non lo hai ricevuto.',
        ),
        result.code ? el('p', { class: 'amount' }, result.code) : null,
      );
      created.append(
        button('Aggiungi piatti', async () => {
          const workspace = await rpc(
            'get_account_workspace',
            { p_account: result.id },
            accountWorkspaceSchema,
          );
          created.close();
          const { orderDialog } = await import('./accounts');
          await orderDialog(context, result.id, workspace.account.version);
        }),
        button(
          'Vai al conto',
          () => {
            created.close();
            context.navigate(`/conti/${result.id}`);
          },
          'secondary',
        ),
      );
      toast('Conto creato.');
    }),
  );
  name.input.focus();
}
