import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { floorSchema, tableLabel, type FloorTable } from '../components/floor-view';
import { button, dialog, el, emptyState, status, toast } from '../components/dom';
import {
  groupWaiterSteps,
  isRunnerOnly,
  sortWaiterTables,
  waiterDeliveryAction,
  type WaiterStepSummary,
} from '../services/waiter-service';
import { openAccountCreation } from './account-create';
import { command } from './staff-context';
import type { StaffContext } from './staff-context';

const waiterCallSchema = z.object({
  id: z.uuid(),
  account_id: z.uuid(),
  table_id: z.uuid(),
  assigned_waiter_id: z.uuid().nullable(),
  kind: z.enum(['WAITER', 'BILL']),
  status: z.enum(['NEW', 'ACCEPTED', 'COMPLETED']),
  created_at: z.string(),
  accepted_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

const deliveryClaimSchema = z.object({
  step_id: z.uuid(),
  waiter_id: z.uuid(),
  claimed_at: z.string(),
  served_at: z.string().nullable(),
});

const assignmentSchema = z.object({
  id: z.uuid(),
  venue_id: z.uuid(),
  waiter_id: z.uuid(),
  mode: z.enum(['TABLE', 'ZONE', 'RUNNER']),
  table_id: z.uuid().nullable(),
  zone_id: z.uuid().nullable(),
  active: z.boolean(),
});

const kitchenItemSchema = z.object({
  id: z.uuid(),
  order_id: z.uuid(),
  step_id: z.uuid(),
  step_number: z.number(),
  step_status: z.string(),
  table_name: z.string(),
  table_number: z.number(),
  dish_name: z.string(),
  quantity: z.number(),
  status: z.string(),
  station_id: z.uuid(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  version: z.number(),
  can_prepare: z.boolean(),
  can_deliver: z.boolean(),
  removed_ingredients: z.array(z.string()),
  variants: z.array(z.object({ group: z.string(), option: z.string() })),
});

const accountLookupSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      account_name: z.string(),
      table_name: z.string(),
      covers: z.number().int(),
      status: z.string(),
      version: z.number().int(),
      created_at: z.string(),
    }),
  ),
  has_more: z.boolean(),
});

function elapsedLabel(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'adesso';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function tableTone(state: string): string {
  if (state === 'WAITING_BILL') return 'danger';
  if (state === 'WAITING_SERVICE' || state === 'ORDERING') return 'warning';
  if (state === 'AVAILABLE') return 'success';
  return 'neutral';
}

async function lookupTableAccount(context: StaffContext, tableId: string) {
  const data = await rpc(
    'search_accounts',
    {
      p_venue: context.venue!.id,
      p_table: tableId,
      p_search: '',
      p_status: 'ACTIVE',
      p_from: null,
      p_to: null,
      p_before_at: null,
      p_before_id: null,
      p_limit: 2,
    },
    accountLookupSchema,
  );
  if (data.items.length === 1 && !data.has_more) return data.items[0]!;
  if (data.items.length === 0) return null;
  context.navigate(`/conti?tavolo=${tableId}`);
  return undefined;
}

async function quickOrder(context: StaffContext, table: FloorTable): Promise<void> {
  const account = await lookupTableAccount(context, table.id);
  if (account === undefined) return;
  if (!account) {
    toast('Apri prima un conto per questo tavolo.', true);
    openAccountCreation(context, table);
    return;
  }
  const { orderDialog } = await import('./accounts');
  await orderDialog(context, account.id, account.version);
}

async function openTableAccount(context: StaffContext, table: FloorTable): Promise<void> {
  const account = await lookupTableAccount(context, table.id);
  if (account === undefined) return;
  if (!account) {
    openAccountCreation(context, table);
    return;
  }
  context.navigate(`/conti/${account.id}`);
}

function deliveryCard(
  context: StaffContext,
  step: WaiterStepSummary,
  ownClaimedStepIds: ReadonlySet<string>,
): HTMLElement {
  const action = waiterDeliveryAction(step, ownClaimedStepIds);
  const card = el(
    'article',
    { class: 'card waiter-delivery-card stack' },
    el(
      'div',
      { class: 'row between waiter-card-heading' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, `STEP ${step.stepNumber}`),
        el('h2', {}, step.tableName),
      ),
      status(
        action === 'CONFIRM_SERVED'
          ? 'CONSEGNA IN CARICO A TE'
          : step.status === 'READY'
            ? 'PRONTO PER IL SERVIZIO'
            : step.status,
      ),
    ),
    el('p', { class: 'muted service-timer' }, `Comanda aperta da ${elapsedLabel(step.createdAt)}`),
    el(
      'div',
      { class: 'waiter-dishes' },
      ...step.items.map((item) =>
        el('span', { class: 'waiter-dish-line' }, `${item.quantity} × ${item.dish_name}`),
      ),
    ),
  );
  if (action === 'CLAIM') {
    card.append(
      el(
        'div',
        { class: 'stack' },
        el(
          'p',
          { class: 'muted' },
          'Prendi in carico lo step prima di segnalarlo consegnato. Il server impedisce di assegnare la stessa consegna a due persone.',
        ),
        button('Prendi in carico', async () => {
          await command('deliver_step', { p_step: step.id, p_served: false });
          toast(`${step.tableName}: consegna presa in carico.`);
          await context.refresh?.();
        }),
      ),
    );
  } else if (action === 'CONFIRM_SERVED') {
    card.append(
      button('Conferma consegna al tavolo', () => {
        const confirmation = dialog(
          'Confermare la consegna',
          el('p', {}, `${step.tableName} · Step ${step.stepNumber}`),
          el(
            'p',
            {},
            'Conferma solo dopo aver consegnato i piatti ai clienti. L’azione segna lo step come SERVED.',
          ),
        );
        confirmation.append(
          button('Sì, piatti consegnati', async () => {
            await command('deliver_step', { p_step: step.id, p_served: true });
            confirmation.close();
            toast(`${step.tableName}: step servito.`);
            await context.refresh?.();
          }),
        );
      }),
    );
  }
  return card;
}

export async function waiterPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venue)
    return emptyState(
      'Nessuna sede assegnata',
      'Contatta l’amministratore per configurare il servizio.',
    );

  const [floor, kitchenItems, calls, assignments, ownDeliveries] = await Promise.all([
    rpc('get_floor_workspace', { p_venue: context.venue.id }, floorSchema),
    rpc('get_kitchen_board', { p_venue: context.venue.id }, z.array(kitchenItemSchema)),
    readRows('waiter_calls', waiterCallSchema, context.venue.id, {
      assigned_waiter_id: context.profile.id,
    }),
    readRows('table_assignments', assignmentSchema, context.venue.id, {
      waiter_id: context.profile.id,
    }),
    readRows('step_deliveries', deliveryClaimSchema, context.venue.id, {
      waiter_id: context.profile.id,
      served_at: null,
    }),
  ]);

  const activeCalls = calls
    .filter((call) => call.status !== 'COMPLETED')
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
  const assignedTables = sortWaiterTables(
    floor.tables.filter((table) => table.can_open_account === true),
  );
  const steps = groupWaiterSteps(kitchenItems);
  const ownClaimedStepIds = new Set(ownDeliveries.map((delivery) => delivery.step_id));
  const readySteps = steps.filter((step) => step.status === 'READY' && step.canDeliver);
  const activeSteps = steps.filter((step) => step.status !== 'READY');
  const runnerOnly = isRunnerOnly(assignments, assignedTables.length);

  const root = el('section', {
    class: `waiter-service stack${runnerOnly ? ' runner-mode' : ''}`,
    'aria-label': runnerOnly ? 'Consegne Runner' : 'Servizio cameriere',
  });

  root.append(
    el(
      'div',
      { class: 'waiter-priority-bar', role: 'status', 'aria-label': 'Riepilogo servizio' },
      el(
        'div',
        { class: 'waiter-counter' },
        el('strong', {}, String(readySteps.length)),
        el('span', {}, 'Pronti'),
      ),
      el(
        'div',
        { class: 'waiter-counter' },
        el('strong', {}, String(activeCalls.length)),
        el('span', {}, 'Chiamate'),
      ),
      el(
        'div',
        { class: 'waiter-counter' },
        el('strong', {}, String(runnerOnly ? readySteps.length : assignedTables.length)),
        el('span', {}, runnerOnly ? 'Consegne' : 'Tavoli'),
      ),
    ),
  );

  if (runnerOnly) {
    root.append(
      el(
        'div',
        { class: 'row between waiter-section-heading' },
        el(
          'div',
          {},
          el('p', { class: 'eyebrow' }, 'RUNNER'),
          el('h2', {}, 'Piatti da consegnare'),
        ),
        el('span', { class: 'muted' }, `${readySteps.length} step pronti`),
      ),
    );
    if (!readySteps.length)
      root.append(
        emptyState(
          'Nessuna consegna pronta',
          'I nuovi step pronti compariranno qui in tempo reale.',
        ),
      );
    else
      root.append(
        el(
          'div',
          { class: 'waiter-delivery-grid' },
          ...readySteps.map((step) => deliveryCard(context, step, ownClaimedStepIds)),
        ),
      );
    return root;
  }

  if (activeCalls.length) {
    const section = el(
      'section',
      { class: 'stack waiter-alert-section', 'aria-label': 'Chiamate clienti' },
      el(
        'div',
        { class: 'row between waiter-section-heading' },
        el('h2', {}, 'Da gestire'),
        status(`${activeCalls.length} CHIAMATE`),
      ),
    );
    for (const call of activeCalls) {
      const table = floor.tables.find((entry) => entry.id === call.table_id);
      section.append(
        el(
          'article',
          { class: 'card waiter-call-card stack' },
          el(
            'div',
            { class: 'row between waiter-card-heading' },
            el(
              'h3',
              {},
              `${call.kind === 'BILL' ? 'Conto richiesto' : 'Chiamata cliente'} · ${table?.name ?? 'Tavolo'}`,
            ),
            status(call.status),
          ),
          el(
            'p',
            { class: 'muted service-timer' },
            `In attesa da ${elapsedLabel(call.created_at)}`,
          ),
          el(
            'div',
            { class: 'row waiter-actions' },
            button(call.status === 'NEW' ? 'Prendi in carico' : 'Completa chiamata', async () => {
              await command('transition_waiter_call', {
                p_call: call.id,
                p_complete: call.status === 'ACCEPTED',
              });
              await context.refresh?.();
            }),
            button('Apri conto', () => context.navigate(`/conti/${call.account_id}`), 'secondary'),
          ),
        ),
      );
    }
    root.append(section);
  }

  if (readySteps.length) {
    root.append(
      el(
        'section',
        { class: 'stack', 'aria-label': 'Piatti pronti' },
        el(
          'div',
          { class: 'row between waiter-section-heading' },
          el('h2', {}, 'Pronti da servire'),
          status(`${readySteps.length} STEP`),
        ),
        el(
          'div',
          { class: 'waiter-delivery-grid' },
          ...readySteps.map((step) => deliveryCard(context, step, ownClaimedStepIds)),
        ),
      ),
    );
  }

  root.append(
    el(
      'section',
      { class: 'stack', 'aria-label': 'Tavoli assegnati' },
      el(
        'div',
        { class: 'row between waiter-section-heading' },
        el('h2', {}, 'I miei tavoli'),
        el('span', { class: 'muted' }, `${assignedTables.length} assegnati`),
      ),
      assignedTables.length
        ? el(
            'div',
            { class: 'waiter-table-grid' },
            ...assignedTables.map((table) => {
              const room = floor.rooms.find((entry) => entry.id === table.room_id)?.name;
              const zone = floor.zones.find((entry) => entry.id === table.zone_id)?.name;
              const pill = status(tableLabel(floor, table));
              pill.dataset.tone = tableTone(table.technical_status);
              return el(
                'article',
                { class: 'card waiter-table-card stack', 'data-state': table.technical_status },
                el(
                  'div',
                  { class: 'row between waiter-card-heading' },
                  el(
                    'div',
                    {},
                    el('p', { class: 'eyebrow' }, `TAVOLO ${table.number}`),
                    el('h2', {}, table.name),
                  ),
                  pill,
                ),
                el('p', { class: 'muted' }, [room, zone].filter(Boolean).join(' · ')),
                el(
                  'div',
                  { class: 'waiter-table-facts' },
                  el('span', {}, `${table.covers}/${table.seats} coperti`),
                  el(
                    'span',
                    {},
                    `${table.open_accounts} ${table.open_accounts === 1 ? 'conto' : 'conti'}`,
                  ),
                ),
                el(
                  'div',
                  { class: 'row waiter-actions' },
                  table.open_accounts > 0
                    ? button('Nuovo ordine', () => quickOrder(context, table))
                    : table.technical_status === 'TO_RESET'
                      ? // A closed table must be reset before a new account (TABLE_NEEDS_RESET).
                        button('Tavolo riapparecchiato', async () => {
                          await command('set_table_available', { p_table: table.id });
                          toast(`${table.name}: pronto per nuovi clienti.`);
                          await context.refresh?.();
                        })
                      : button('Nuovo conto', () => openAccountCreation(context, table)),
                  button('Apri conto', () => openTableAccount(context, table), 'secondary'),
                  button(
                    'Dettagli tavolo',
                    () => context.navigate(`/sala?tavolo=${table.id}`),
                    'quiet',
                  ),
                ),
              );
            }),
          )
        : emptyState(
            'Nessun tavolo assegnato',
            'Le assegnazioni del servizio compariranno qui automaticamente.',
          ),
    ),
  );

  if (activeSteps.length)
    root.append(
      el(
        'section',
        { class: 'stack waiter-active-orders', 'aria-label': 'Ordini attivi' },
        el(
          'div',
          { class: 'row between waiter-section-heading' },
          el('h2', {}, 'Ordini in corso'),
          el('span', { class: 'muted' }, `${activeSteps.length} step`),
        ),
        ...activeSteps
          .slice(0, 8)
          .map((step) =>
            el(
              'article',
              { class: 'waiter-order-row' },
              el('strong', {}, `${step.tableName} · Step ${step.stepNumber}`),
              status(step.status),
              el(
                'span',
                { class: 'muted' },
                `${step.items.reduce((sum, item) => sum + item.quantity, 0)} piatti · ${elapsedLabel(step.createdAt)}`,
              ),
            ),
          ),
      ),
    );

  return root;
}
