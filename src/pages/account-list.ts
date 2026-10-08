import { z } from 'zod';
import { rpc } from '../api/client';
import { button, el, field, showError, status } from '../components/dom';
import type { StaffContext } from './staff-context';

const rowSchema = z.object({
  id: z.uuid(),
  account_name: z.string(),
  table_name: z.string(),
  covers: z.number().int(),
  status: z.string(),
  created_at: z.string(),
});
export async function accountList(context: StaffContext): Promise<HTMLElement> {
  const search = field('Conto, tavolo o ID', 'search'),
    from = field('Aperti dal', 'from', 'datetime-local'),
    to = field('Aperti fino al', 'to', 'datetime-local');
  search.input.maxLength = 100;
  const state = el(
    'select',
    {},
    el('option', { value: 'ACTIVE' }, 'Conti attivi'),
    el('option', { value: 'CLOSED' }, 'Conti chiusi'),
    el('option', { value: 'ALL' }, 'Tutti i conti'),
  );
  const rows = el('div', { class: 'grid' }),
    feedback = el('p', { class: 'muted', role: 'status' });
  const table = new URLSearchParams(location.search).get('tavolo');
  const tableId = table ? z.uuid().parse(table) : null;
  let cursor: { id: string; at: string } | null = null,
    revision = 0;
  let applied: Record<string, unknown> = {
    p_search: '',
    p_status: 'ACTIVE',
    p_from: null,
    p_to: null,
  };
  const more = button('Carica altri conti', () => load(true), 'secondary');
  more.hidden = true;
  async function load(append = false): Promise<void> {
    const version = ++revision;
    if (!append) cursor = null;
    const data = await rpc(
      'search_accounts',
      {
        p_venue: context.venue!.id,
        p_table: tableId,
        ...applied,
        p_before_at: cursor?.at ?? null,
        p_before_id: cursor?.id ?? null,
        p_limit: 50,
      },
      z.object({ items: z.array(rowSchema), has_more: z.boolean() }),
    );
    if (version !== revision) return;
    if (!append) rows.replaceChildren();
    for (const account of data.items)
      rows.append(
        el(
          'article',
          { class: 'card stack' },
          el(
            'div',
            { class: 'row between' },
            el('h2', {}, account.account_name),
            status(account.status),
          ),
          el(
            'p',
            { class: 'muted' },
            `${account.table_name} · ${account.covers} coperti · ${new Date(account.created_at).toLocaleString('it-IT')}`,
          ),
          button('Apri conto', () => context.navigate(`/conti/${account.id}`)),
        ),
      );
    const last = data.items.at(-1);
    cursor = last ? { id: last.id, at: last.created_at } : null;
    more.hidden = !data.has_more;
    feedback.textContent = rows.childElementCount
      ? `${rows.childElementCount} conti caricati.`
      : 'Nessun conto per questi filtri.';
  }
  const filters = el(
    'form',
    { class: 'card stack' },
    el(
      'div',
      { class: 'grid' },
      search.root,
      el('label', { class: 'field' }, 'Stato', state),
      from.root,
      to.root,
    ),
    el('button', { class: 'button secondary', type: 'submit' }, 'Cerca conti'),
  );
  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    applied = {
      p_search: search.input.value,
      p_status: state.value,
      p_from: from.input.value ? new Date(from.input.value).toISOString() : null,
      p_to: to.input.value ? new Date(to.input.value).toISOString() : null,
    };
    void load().catch(showError);
  });
  const view = el(
    'section',
    { class: 'stack' },
    filters,
    tableId ? el('a', { href: '/conti', class: 'button quiet' }, 'Mostra tutti i tavoli') : null,
    feedback,
    rows,
    more,
  );
  context.refresh = () => load();
  await load();
  return view;
}
