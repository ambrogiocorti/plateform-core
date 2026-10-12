import { z } from 'zod';
import { client, rpc, safeError } from '../api/client';
import { floorSchema } from '../components/floor-view';
import { button, el, emptyState, status } from '../components/dom';
import {
  customerCallAttention,
  deliveryAttention,
  formatWaitDuration,
  waitingSeconds,
} from '../services/operational-exceptions';
import type {
  ClaimedDelivery,
  WaitingCustomerCall,
} from '../services/operational-exceptions';
import type { StaffContext } from './staff-context';

const callSchema = z.object({
  id: z.uuid(),
  table_id: z.uuid(),
  kind: z.enum(['WAITER', 'BILL']),
  status: z.enum(['NEW', 'ACCEPTED', 'COMPLETED']),
  created_at: z.string(),
  accepted_at: z.string().nullable(),
  assigned_waiter_id: z.uuid().nullable(),
});
const claimSchema = z.object({
  step_id: z.uuid(),
  waiter_id: z.uuid(),
  claimed_at: z.string(),
  served_at: z.string().nullable(),
});
const financeAttentionSchema = z.object({
  cash: z.object({
    open_registers: z.number().int(),
    open_services: z.number().int(),
    pending_payments: z.number().int(),
    pending_reconciliations: z.number().int(),
  }),
});

const kitchenRow = z.object({
  step_id: z.uuid(),
  step_number: z.number().int(),
  step_status: z.string(),
  table_name: z.string().nullable(),
});

async function loadOpenCalls(venue: string) {
  const request = await client()
    .from('waiter_calls')
    .select('id,table_id,kind,status,created_at,accepted_at,assigned_waiter_id')
    .eq('venue_id', venue)
    .in('status', ['NEW', 'ACCEPTED'])
    .order('created_at', { ascending: true })
    .limit(51);
  if (request.error) throw safeError(request.error);
  const parsed = z.array(callSchema).parse(request.data);
  return { rows: parsed.slice(0, 50) as WaitingCustomerCall[], hasMore: parsed.length > 50 };
}

async function loadUnservedDeliveries(venue: string) {
  const request = await client()
    .from('step_deliveries')
    .select('step_id,waiter_id,claimed_at,served_at')
    .eq('venue_id', venue)
    .is('served_at', null)
    .order('claimed_at', { ascending: true })
    .limit(51);
  if (request.error) throw safeError(request.error);
  const parsed = z.array(claimSchema).parse(request.data);
  return { rows: parsed.slice(0, 50) as ClaimedDelivery[], hasMore: parsed.length > 50 };
}

/**
 * This is a read-only triage console. Calls may only be transitioned by the
 * waiter they were assigned to; deliveries are owned by the claiming waiter.
 * An Admin does NOT acquire those permissions from this dashboard.
 */
export async function serviceExceptionsPage(context: StaffContext): Promise<HTMLElement> {
  if (context.profile.role !== 'ADMIN')
    return emptyState('Accesso non autorizzato', 'Questa vista è riservata agli Admin.');
  const venue = context.venue;
  if (!venue)
    return emptyState('Nessuna sede', 'Seleziona una sede autorizzata.');

  const root = el('div', { class: 'stack' });
  let revision = 0;
  const refresh = async () => {
    const currentRevision = ++revision;
    const [calls, deliveries, floor, kitchen, finance] = await Promise.all([
      loadOpenCalls(venue.id),
      loadUnservedDeliveries(venue.id),
      rpc('get_floor_workspace', { p_venue: venue.id }, floorSchema),
      rpc('get_kitchen_board', { p_venue: venue.id }, z.array(kitchenRow)),
      rpc('get_admin_operational_overview', { p_venue: venue.id }, financeAttentionSchema),
    ]);
    if (currentRevision !== revision) return;
    const now = Date.now();
    const tables = new Map(floor.tables.map((table) => [table.id, table]));
    const steps = new Map(kitchen.map((item) => [item.step_id, item]));
    const waitingCalls = calls.rows.filter(
      (call) => customerCallAttention(call, now) === 'DELAYED',
    );
    const delayedDeliveries = deliveries.rows.filter(
      (claim) => deliveryAttention(claim, steps.get(claim.step_id)?.step_status, now) === 'DELAYED',
    );
    const callList = el('section', { class: 'stack' });
    for (const call of calls.rows) {
      const table = tables.get(call.table_id);
      const elapsed = waitingSeconds(
        call.status === 'ACCEPTED' ? call.accepted_at ?? call.created_at : call.created_at,
        now,
      );
      const delayed = customerCallAttention(call, now) === 'DELAYED';
      callList.append(
        el(
          'article',
          { class: 'card row between' },
          el(
            'div',
            { class: 'stack' },
            el(
              'h3',
              {},
              `${call.kind === 'BILL' ? 'Richiesta conto' : 'Chiamata cameriere'} · ${table?.name ?? 'Tavolo'}`,
            ),
            status(call.status === 'NEW' ? 'Da prendere in carico' : 'In gestione'),
            el(
              'p',
              { class: 'muted' },
              `Attesa ${formatWaitDuration(elapsed)}${delayed ? ' · Da verificare' : ''}`,
            ),
            el(
              'p',
              { class: 'muted' },
              call.assigned_waiter_id
                ? 'Assegnata a un cameriere. Solo il responsabile può completarla.'
                : 'Nessun cameriere assegnato. Verifica i turni e le assegnazioni.',
            ),
          ),
          button(
            'Apri tavolo',
            () => context.navigate(`/sala?tavolo=${call.table_id}`),
            'secondary',
          ),
        ),
      );
    }
    if (!calls.rows.length)
      callList.append(
        emptyState('Nessuna chiamata attiva', 'Le chiamate già completate non sono elencate.'),
      );
    if (calls.hasMore)
      callList.append(
        el(
          'p',
          { role: 'status' },
          'Sono visualizzate le 50 chiamate più vecchie; verifica la presenza di altre richieste.',
        ),
      );

    const deliveryList = el('section', { class: 'stack' });
    for (const claim of deliveries.rows) {
      const step = steps.get(claim.step_id);
      const delayed = deliveryAttention(claim, step?.step_status, now) === 'DELAYED';
      deliveryList.append(
        el(
          'article',
          { class: 'card row between' },
          el(
            'div',
            { class: 'stack' },
            el(
              'h3',
              {},
              step?.table_name
                ? `${step.table_name} · Step ${step.step_number}`
                : 'Consegna da verificare',
            ),
            status(delayed ? 'Controllo operatore richiesto' : 'Presa in carico'),
            el(
              'p',
              { class: 'muted' },
              `Presa in carico da ${formatWaitDuration(waitingSeconds(claim.claimed_at, now))}`,
            ),
            el(
              'p',
              { class: 'muted' },
              'La conferma SERVED spetta al cameriere/Runner che ha preso la consegna. Non riassegnare senza verificare lo stato reale dei piatti.',
            ),
          ),
          button('Controlla cucina', () => context.navigate('/cucina'), 'secondary'),
        ),
      );
    }
    if (!deliveries.rows.length)
      deliveryList.append(
        emptyState(
          'Nessuna consegna presa in carico',
          'Non risultano claim di consegna ancora aperti.',
        ),
      );
    if (deliveries.hasMore)
      deliveryList.append(
        el(
          'p',
          { role: 'status' },
          'Sono visualizzate le 50 consegne più vecchie; potrebbero essercene altre.',
        ),
      );

    root.replaceChildren(
      el(
        'header',
        { class: 'card stack' },
        el('p', { class: 'eyebrow' }, 'CONTROLLO DEL SERVIZIO'),
        el('h2', {}, `Eccezioni operative · ${venue.name}`),
        el(
          'p',
          { class: 'muted' },
          'Vista in sola lettura, aggiornata dal database della sede. I tempi di attenzione (5 minuti per una chiamata nuova, 10 minuti dopo accettazione o presa in carico consegna) sono indicazioni operative, non SLA certificati.',
        ),
        el(
          'p',
          { role: 'status', 'aria-live': 'polite' },
          `${waitingCalls.length} chiamate oltre soglia · ${delayedDeliveries.length} consegne da verificare`,
        ),
        button('Aggiorna situazione', refresh, 'secondary'),
        button('Gestisci assegnazioni staff', () => context.navigate('/staff'), 'secondary'),
      ),
      el('section', { class: 'stack' }, el('h2', {}, 'Chiamate e richieste conto'), callList),
      el('section', { class: 'stack' }, el('h2', {}, 'Consegne già prese in carico'), deliveryList),
      el(
        'section',
        { class: 'card stack', 'aria-label': 'Verifiche contabili' },
        el('h2', {}, 'Pagamenti e quadratura'),
        el(
          'p',
          { role: 'status' },
          `${finance.cash.pending_payments} pagamenti da verificare · ${finance.cash.pending_reconciliations} quadrature in attesa · ${finance.cash.open_services} servizi contabili aperti`,
        ),
        el(
          'p',
          { class: 'muted' },
          'Verifica gli esiti POS/contanti prima di confermarli. Le quadrature con differenza richiedono l’approvazione prevista dal server.',
        ),
        button('Apri Cassa e quadrature', () => context.navigate('/cassa'), 'secondary'),
      ),
    );
  };
  context.refresh = refresh;
  await refresh();
  return root;
}
