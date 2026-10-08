import { z } from 'zod';
import { rpc } from '../api/client';
import { button, dialog, el, field, showError, status } from '../components/dom';

const eventSchema = z.object({
  id: z.uuid(),
  timestamp: z.string(),
  action: z.string(),
  resource_type: z.string(),
  result: z.string(),
  old_values: z.unknown(),
  new_values: z.unknown(),
  request_id: z.uuid(),
  correlation_id: z.uuid(),
  impersonation_write_enabled: z.boolean(),
  actor_user_id: z.uuid().nullable(),
  actor_role: z.string().nullable(),
  venue_id: z.uuid().nullable(),
  resource_id: z.uuid().nullable(),
  impersonated_by: z.uuid().nullable(),
  account_id: z.uuid().nullable(),
  cash_register_id: z.uuid().nullable(),
  service_session_id: z.uuid().nullable(),
  device_id: z.uuid().nullable(),
});

export async function auditPage(): Promise<HTMLElement> {
  const action = field('Evento', 'action');
  action.input.maxLength = 100;
  const actor = field('ID utente', 'actor'),
    venue = field('ID sede', 'venue'),
    resource = field('ID risorsa', 'resource'),
    request = field('ID richiesta', 'request'),
    correlation = field('ID correlazione', 'correlation'),
    resourceType = field('Tipo risorsa', 'resource-type');
  resourceType.input.maxLength = 100;
  const role = el(
    'select',
    {},
    el('option', { value: '' }, 'Tutti'),
    ...[
      'SUPER_ADMIN',
      'ADMIN',
      'HOST',
      'CASHIER',
      'KITCHEN_ADMIN',
      'KITCHEN_STAFF',
      'PASS',
      'WAITER',
      'CUSTOMER',
      'SYSTEM',
    ].map((value) => el('option', { value }, value)),
  );
  const impersonation = el(
    'select',
    {},
    el('option', { value: '' }, 'Tutti gli eventi'),
    el('option', { value: 'true' }, 'Durante impersonazione'),
    el('option', { value: 'false' }, 'Senza impersonazione'),
  );
  for (const entry of [actor, venue, resource, request, correlation])
    entry.input.addEventListener('input', () => entry.input.setCustomValidity(''));
  const from = field('Dal', 'from', 'datetime-local'),
    to = field('Al', 'to', 'datetime-local');
  const result = el(
    'select',
    {},
    el('option', { value: '' }, 'Tutti'),
    ...['SUCCESS', 'DENIED', 'FAILURE'].map((value) => el('option', { value }, value)),
  );
  const rows = el('tbody'),
    feedback = el('p', { role: 'status', class: 'muted' });
  let cursor: { at: string; id: string } | null = null;
  let version = 0;
  let appliedFilters: Record<string, unknown> = {};
  const filters = el(
    'form',
    { class: 'card stack' },
    el(
      'div',
      { class: 'grid' },
      action.root,
      actor.root,
      venue.root,
      resource.root,
      request.root,
      correlation.root,
      resourceType.root,
      from.root,
      to.root,
      el('label', { class: 'field' }, 'Esito', result),
      el('label', { class: 'field' }, 'Ruolo', role),
      el('label', { class: 'field' }, 'Impersonazione', impersonation),
    ),
    el('button', { type: 'submit', class: 'button secondary' }, 'Cerca eventi'),
  );
  const more = button('Carica eventi precedenti', async () => load(true), 'secondary');
  more.hidden = true;
  async function load(append = false): Promise<void> {
    if (!append)
      for (const entry of [actor, venue, resource, request, correlation]) {
        entry.input.setCustomValidity(
          entry.input.value && !z.uuid().safeParse(entry.input.value).success
            ? 'Inserisci un UUID valido.'
            : '',
        );
        if (!entry.input.reportValidity()) return;
      }
    const revision = ++version;
    if (!append) {
      cursor = null;
      appliedFilters = {
        p_venue: venue.input.value || null,
        p_actor: actor.input.value || null,
        p_resource: resource.input.value || null,
        p_request: request.input.value || null,
        p_correlation: correlation.input.value || null,
        p_role: role.value || null,
        p_impersonated: impersonation.value ? impersonation.value === 'true' : null,
        p_resource_type: resourceType.input.value || null,
        p_action: action.input.value,
        p_result: result.value || null,
        p_from: from.input.value ? new Date(from.input.value).toISOString() : null,
        p_to: to.input.value ? new Date(to.input.value).toISOString() : null,
      };
    }
    const data = await rpc(
      'search_audit',
      {
        ...appliedFilters,
        p_before_at: cursor?.at ?? null,
        p_before_id: cursor?.id ?? null,
        p_limit: 50,
      },
      z.object({ events: z.array(eventSchema), has_more: z.boolean() }),
    );
    if (revision !== version) return;
    if (!append) rows.replaceChildren();
    for (const entry of data.events)
      rows.append(
        el(
          'tr',
          {},
          el('td', {}, new Date(entry.timestamp).toLocaleString('it-IT')),
          el('td', {}, entry.action),
          el('td', {}, entry.resource_type),
          el('td', {}, entry.actor_role ?? 'SYSTEM'),
          el('td', {}, status(entry.result)),
          el(
            'td',
            {},
            button(
              'Dettagli',
              () => {
                dialog(
                  'Evento audit',
                  el('p', {}, `Richiesta ${entry.request_id}`),
                  el('p', {}, `Correlazione ${entry.correlation_id}`),
                  el(
                    'p',
                    {},
                    `Utente ${entry.actor_user_id ?? 'SYSTEM'} · sede ${entry.venue_id ?? 'Installazione'}`,
                  ),
                  entry.impersonated_by
                    ? el(
                        'p',
                        {},
                        `Impersonato da ${entry.impersonated_by} · ${entry.impersonation_write_enabled ? 'Scrittura autorizzata' : 'Sola lettura'}`,
                      )
                    : null,
                  el(
                    'p',
                    {},
                    `Conto ${entry.account_id ?? '—'} · Cassa ${entry.cash_register_id ?? '—'} · Servizio ${entry.service_session_id ?? '—'}`,
                  ),
                  el('h3', {}, 'Prima'),
                  el('pre', {}, JSON.stringify(entry.old_values, null, 2)),
                  el('h3', {}, 'Dopo'),
                  el('pre', {}, JSON.stringify(entry.new_values, null, 2)),
                );
              },
              'quiet',
            ),
          ),
        ),
      );
    const last = data.events.at(-1);
    cursor = last ? { at: last.timestamp, id: last.id } : null;
    more.hidden = !data.has_more;
    feedback.textContent = rows.childElementCount
      ? `${rows.childElementCount} eventi caricati.`
      : 'Nessun evento per questi filtri.';
  }
  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    void load().catch(showError);
  });
  const view = el(
    'section',
    { class: 'stack' },
    filters,
    feedback,
    el(
      'div',
      { class: 'card table-wrap' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            ...['Data', 'Evento', 'Risorsa', 'Ruolo', 'Esito', 'Dettagli'].map((label) =>
              el('th', {}, label),
            ),
          ),
        ),
        rows,
      ),
    ),
    more,
  );
  await load();
  return view;
}
