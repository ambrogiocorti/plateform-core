import { z } from 'zod';
import { client, readRows, rpc, safeError } from '../api/client';
import { button, dialog, el, field, status, toast } from '../components/dom';
import {
  authorizationSchema,
  enqueueStep,
  enqueueTableReset,
  offlineAuthorization,
  queuedEvents,
  vaultGet,
  vaultPut,
  clearOffline,
} from '../offline/store';
import type { StaffContext } from './staff-context';
import { staffProfileSchema, venueSchema } from '../types/domain';
import { accountWorkspaceSchema } from '../types/accounts';
import { orderDialog } from './accounts';
import { floorView } from '../components/floor-view';
import { offlineWorkspaceKey, offlineWorkspaceSchema } from '../offline/workspace';
import { offlineVerificationKeys } from '../offline/authorization';
import { reconcileOfflineEvents, replayOfflineEvents } from '../offline/sync-engine';
import { isTerminalOfflineStatus } from '../offline/queue-policy';
const contextSchema = z.object({
  profile: staffProfileSchema,
  venues: z.array(venueSchema),
  venue: venueSchema.nullable(),
  multiVenue: z.boolean(),
});
let syncing = false;
const remoteStatusSchema = z.array(
  z.object({
    client_event_id: z.uuid(),
    sync_status: z.enum(['PENDING', 'SYNCING', 'SYNCED', 'CONFLICT', 'REJECTED', 'RESOLVED']),
    result: z.unknown().optional(),
  }),
);
export async function syncQueue(): Promise<void> {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    if (!navigator.locks) throw new Error('OFFLINE_BROWSER_UNSUPPORTED');
    await navigator.locks.request('plateform-offline-queue', async () => {
      let events = await queuedEvents();
      const {
        data: { session },
      } = await client().auth.getSession();
      if (!session) return;

      await reconcileOfflineEvents(
        events,
        session.user.id,
        async (venue, clientEvents) =>
          await rpc(
            'get_offline_sync_statuses',
            { p_venue: venue, p_client_events: clientEvents },
            remoteStatusSchema,
          ),
        async () => await vaultPut('queue', events),
      );
      await replayOfflineEvents(
        events,
        session.user.id,
        async (event) => {
          const result = await rpc(
            'sync_offline_event',
            {
              p_authorization: event.authorization_id,
              p_client_event: event.client_event_id,
              p_key: event.idempotency_key,
              p_venue: event.venue_id,
              p_resource: event.resource_id,
              p_operation: event.operation,
              p_version: event.base_version,
              p_payload: event.payload,
              p_created_at: event.created_at_local,
              p_predecessor: event.predecessor_id,
            },
            z.object({ id: z.uuid(), status: z.enum(['SYNCED', 'CONFLICT']), result: z.unknown() }),
          );
          return {
            client_event_id: event.client_event_id,
            sync_status: result.status,
            result: result.result,
          };
        },
        async () => await vaultPut('queue', events),
      );

    });
  } finally {
    syncing = false;
  }
}

async function refreshOfflineSnapshotAfterReconnect(context: StaffContext): Promise<void> {
  if (!navigator.onLine || !context.venue) return;
  try {
    await prepareOffline(context, false);
  } catch (error) {
    await clearOffline();
    throw error;
  }
}

export async function reconcileAfterReconnect(context: StaffContext): Promise<void> {
  await refreshOfflineSnapshotAfterReconnect(context);
}

export async function prepareOffline(context: StaffContext, notify = true): Promise<void> {
  if (!offlineVerificationKeys().length) throw new Error('OFFLINE_VERIFICATION_KEY_REQUIRED');
  const pending = await queuedEvents();
  if (pending.some((e) => !isTerminalOfflineStatus(e.sync_status) && e.user_id !== context.profile.id))
    throw new Error('OFFLINE_OTHER_USER_QUEUE');
  const { data, error } = await client().functions.invoke('offline-authorization', { body: {} });
  if (error) throw safeError(error);
  await vaultPut('authorization', authorizationSchema.parse(data));
  if (!(await offlineAuthorization())) throw new Error('INVALID_OFFLINE_SIGNATURE');
  await vaultPut('context', {
    profile: context.profile,
    venues: context.venues,
    venue: context.venue,
    multiVenue: context.multiVenue,
  });
  if (!context.venue) return;
  const operations = await rpc(
    'get_offline_operational_workspace',
    { p_venue: context.venue.id },
    offlineWorkspaceSchema,
  );
  for (const account of operations.accounts)
    await rpc('get_account_workspace', { p_account: account.id }, accountWorkspaceSchema);
  await rpc('get_public_menu', { p_venue: context.venue.id }, z.array(z.unknown()));
  await vaultPut(offlineWorkspaceKey(context.profile.id, context.venue.id), operations);
  if (notify)
    toast('Sala, comande e operazioni autorizzate preparate per l’uso offline sul dispositivo.');
}
export async function offlinePage(): Promise<HTMLElement> {
  const root = el(
    'main',
    { class: 'workspace stack', id: 'main' },
    el('p', { class: 'eyebrow' }, 'MODALITÀ OFFLINE'),
  );
  const verified = await offlineAuthorization(),
    saved = await vaultGet('context', contextSchema);
  if (
    !verified ||
    !saved ||
    saved.profile.id !== verified.claims.user_id ||
    saved.profile.role !== verified.claims.role ||
    saved.profile.scope !== verified.claims.scope ||
    !saved.venue ||
    !verified.claims.venue_ids.includes(saved.venue.id)
  ) {
    root.append(
      el('h1', {}, 'Accesso offline scaduto o non preparato'),
      el(
        'p',
        {},
        'Riconnettiti e accedi per riprendere il lavoro. Le operazioni in coda restano conservate.',
      ),
      button('Riprova', () => location.reload()),
    );
    return root;
  }
  root.append(
    el('h1', {}, saved.venue?.name ?? 'Servizio offline'),
    el(
      'p',
      {},
      `Autorizzazione valida fino alle ${new Date(verified.claims.expires_at).toLocaleTimeString('it-IT')}. Gli ordini in coda saranno verificati dal server alla riconnessione.`,
    ),
  );
  const context: StaffContext = {
    ...saved,
    navigate: () => {
      void offlinePage().then((view) => document.getElementById('app')?.replaceChildren(view));
    },
  };
  const operations = await vaultGet(
    offlineWorkspaceKey(verified.claims.user_id, saved.venue.id),
    offlineWorkspaceSchema,
  );
  if (!operations) {
    root.append(
      el(
        'p',
        {},
        'Lo snapshot operativo non è completo. Riconnettiti e prepara nuovamente i dati.',
      ),
    );
    return root;
  }
  root.append(
    el(
      'p',
      { class: 'muted' },
      `Dati sincronizzati ${new Date(operations.captured_at).toLocaleString('it-IT')}. Gli stati mostrati possono essere cambiati su altri dispositivi.`,
    ),
  );
  if (operations.floor)
    root.append(
      floorView(operations.floor, (table) => {
        dialog(
          table.name,
          status(table.technical_status),
          el('p', {}, `${table.covers} ospiti · ${table.open_accounts} conti sincronizzati`),
        );
      }),
    );
  if (verified.claims.role === 'WAITER')
    for (const account of operations.accounts)
      root.append(
        el(
          'section',
          { class: 'card row' },
          el('strong', {}, account.name),
          button('Ordine in coda', () => orderDialog(context, account.id, account.version)),
        ),
      );
  const queue = await queuedEvents(),
    pending = new Set(
      queue
        .filter(
          (event) =>
            !isTerminalOfflineStatus(event.sync_status) &&
            event.user_id === verified.claims.user_id,
        )
        .map((event) => event.resource_id),
    );
  for (const step of operations.steps.filter((step) => step.can_start && !pending.has(step.id)))
    root.append(
      el(
        'section',
        { class: 'card row' },
        el('strong', {}, `${step.table_name} · Step ${step.number}`),
        button(
          'Accoda avvio step',
          async () => {
            await enqueueStep(saved.venue!.id, step.id, step.version);
            toast('Avvio in coda: la cucina lo riceverà dopo la sincronizzazione.');
            context.navigate('/offline');
          },
          'secondary',
        ),
      ),
    );
  for (const table of operations.reset_tables.filter((table) => !pending.has(table.id)))
    root.append(
      el(
        'section',
        { class: 'card row' },
        el('strong', {}, table.name),
        button(
          'Accoda tavolo riapparecchiato',
          async () => {
            await enqueueTableReset(saved.venue!.id, table.id, table.version);
            toast('Tavolo in coda: lo stato sarà confermato dal server.');
            context.navigate('/offline');
          },
          'secondary',
        ),
      ),
    );
  if (operations.kitchen.length) {
    const board = el('section', { class: 'card stack' }, el('h2', {}, 'Comande sincronizzate'));
    for (const item of operations.kitchen)
      board.append(
        el(
          'article',
          {},
          el(
            'strong',
            {},
            `${item.table_name} · Step ${item.step_number} · ${item.quantity} × ${item.dish_name}`,
          ),
          status(item.status),
          ...item.removed_ingredients.map((value) => el('p', {}, `Senza ${value}`)),
          ...item.variants.map((value) => el('p', {}, `${value.group}: ${value.option}`)),
        ),
      );
    root.append(board);
  }
  for (const event of queue.filter((event) => event.user_id === verified.claims.user_id))
    root.append(
      el(
        'div',
        { class: 'card' },
        status(event.sync_status),
        el(
          'p',
          {},
          `${{ CREATE_ORDER: 'Ordine', START_STEP: 'Avvio step', SET_TABLE_AVAILABLE: 'Tavolo riapparecchiato' }[event.operation]} creato ${new Date(event.created_at_local).toLocaleString('it-IT')}`,
        ),
        event.sync_status === 'CONFLICT'
          ? el(
              'p',
              {},
              'Il server ha rifiutato l’operazione. Un amministratore deve verificare il conflitto online.',
            )
          : null,
      ),
    );
  root.append(
    button(
      'Verifica connessione e sincronizza',
      async () => {
        await syncQueue();
        location.reload();
      },
      'secondary',
    ),
  );
  return root;
}
export async function conflictPage(context: StaffContext): Promise<HTMLElement> {
  const conflicts = await readRows(
    'sync_conflicts',
    z.object({
      id: z.uuid(),
      venue_id: z.uuid(),
      sync_event_id: z.uuid(),
      reason_code: z.string(),
      server_snapshot: z.record(z.string(), z.unknown()),
      created_at: z.string(),
      status: z.string(),
    }),
    context.venue?.id,
    { status: 'OPEN' },
  );
  const view = el('div', { class: 'stack' });
  for (const conflict of conflicts) {
    const events = await readRows(
      'offline_sync_events',
      z.object({
        id: z.uuid(),
        user_id: z.uuid(),
        device_id: z.uuid(),
        resource_type: z.string(),
        resource_id: z.uuid(),
        operation: z.string(),
        payload: z.record(z.string(), z.unknown()),
        created_at_local: z.string(),
        received_at: z.string(),
      }),
      context.venue?.id,
      { id: conflict.sync_event_id },
    );
    const event = events[0];
    const reasonLabels: Record<string, string> = {
      OUT_OF_STOCK: 'Disponibilità esaurita durante la sincronizzazione',
      VERSION_CONFLICT: 'La risorsa è stata modificata da un altro dispositivo',
      RESPONSIBLE_WAITER_REQUIRED: 'Il cameriere non è più autorizzato sul tavolo',
      ACCOUNT_NOT_ORDERABLE: 'Il conto non accetta più nuovi ordini',
      OFFLINE_AUTHORIZATION_EXPIRED: 'Autorizzazione offline scaduta',
      OFFLINE_AUTHORIZATION_CHANGED: 'Ruolo o autorizzazioni cambiati',
      OFFLINE_USER_REVOKED: 'Utente disabilitato',
      OFFLINE_DEVICE_REVOKED: 'Dispositivo revocato',
      OFFLINE_SESSION_REVOKED: 'Sessione revocata',
      OFFLINE_OPERATION_REVOKED: 'Funzione offline disabilitata',
      CAUSAL_PREDECESSOR_REQUIRED: 'Operazione precedente non ancora risolta',
      VENUE_FORBIDDEN: 'Accesso alla sede revocato',
      TABLE_STILL_IN_USE: 'Il tavolo risulta ancora occupato',
      STEP_NOT_WAITING: 'Lo step cucina non è più avviabile',
      PREVIOUS_STEP_NOT_SERVED: 'Lo step precedente non risulta ancora servito',
      STEP_ROLE_FORBIDDEN: 'Il ruolo non può più avviare questo step',
      OPERATION_REJECTED: 'Operazione rifiutata dal server',
    };
    const operationLabels: Record<string, string> = {
      CREATE_ORDER: 'Creazione ordine',
      START_STEP: 'Avvio step cucina',
      SET_TABLE_AVAILABLE: 'Tavolo riapparecchiato',
    };
    const resourceType =
      event?.resource_type ??
      (typeof conflict.server_snapshot.resource_type === 'string'
        ? conflict.server_snapshot.resource_type
        : '');
    const resourceId =
      event?.resource_id ??
      (typeof conflict.server_snapshot.resource_id === 'string'
        ? conflict.server_snapshot.resource_id
        : '');
    const serverStatus =
      typeof conflict.server_snapshot.status === 'string'
        ? conflict.server_snapshot.status
        : 'non disponibile';
    const serverVersion =
      typeof conflict.server_snapshot.version === 'number'
        ? String(conflict.server_snapshot.version)
        : '—';
    const card = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, reasonLabels[conflict.reason_code] ?? conflict.reason_code),
      el(
        'p',
        { class: 'muted' },
        `${context.venue?.name ?? conflict.venue_id} · ${operationLabels[event?.operation ?? ''] ?? event?.operation ?? 'Operazione offline'}`,
      ),
      el(
        'p',
        {},
        `Creazione locale ${event?.created_at_local ? new Date(event.created_at_local).toLocaleString('it-IT') : '—'} · Sync ${event?.received_at ? new Date(event.received_at).toLocaleString('it-IT') : '—'}`,
      ),
      el('p', {}, `Utente ${event?.user_id ?? '—'} · Dispositivo ${event?.device_id ?? '—'}`),
      el(
        'p',
        {},
        `Risorsa ${resourceType || '—'} · Stato server ${serverStatus} · Versione ${serverVersion}`,
      ),
      el(
        'details',
        {},
        el('summary', {}, 'Dettagli tecnici'),
        el(
          'pre',
          {},
          JSON.stringify({ requested: event?.payload, server: conflict.server_snapshot }, null, 2),
        ),
      ),
    );
    if (resourceType === 'accounts' && resourceId)
      card.append(
        button(
          'Apri conto aggiornato',
          () => context.navigate(`/conti/${resourceId}`),
          'secondary',
        ),
      );
    else if (resourceType === 'tables')
      card.append(button('Apri sala aggiornata', () => context.navigate('/sala'), 'secondary'));
    card.append(
      button('Gestisci conflitto', () => {
        const reason = field('Motivo della risoluzione', 'reason');
        reason.input.required = true;
        reason.input.minLength = 3;
        const popup = dialog(
          'Risoluzione conflitto',
          el(
            'p',
            {},
            'L’operazione rifiutata non sarà eseguita. Per correggere l’ordine, il cameriere deve crearne uno nuovo dopo aver verificato il conto aggiornato.',
          ),
          reason.root,
        );
        const key = crypto.randomUUID();
        for (const action of ['DISCARD', 'ACKNOWLEDGE'])
          popup.append(
            button(
              action === 'DISCARD' ? 'Annulla richiesta' : 'Segna verificato',
              async () => {
                if (!reason.input.reportValidity()) return;
                await rpc(
                  'resolve_sync_conflict',
                  {
                    p_conflict: conflict.id,
                    p_action: action,
                    p_reason: reason.input.value,
                    p_key: key,
                  },
                  z.object({ id: z.uuid() }),
                );
                popup.close();
                await context.refresh?.();
              },
              'secondary',
            ),
          );
      }),
    );
    view.append(card);
  }
  if (!conflicts.length) view.append(el('p', {}, 'Nessun conflitto da risolvere.'));
  return view;
}
