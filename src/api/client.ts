import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { cachedRpc, cacheRpc } from '../offline/store';
import { environment } from '../config/environment';
import { contextualHeaders } from '../../shared/request-context';

let instance: SupabaseClient | undefined;
export function client(): SupabaseClient {
  if (instance) return instance;
  const config = environment();
  instance = createClient(config.supabaseUrl, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: `plateform-auth-${import.meta.env.PLATEFORM_AREA}`,
    },
    global: {
      fetch: (input, options) => {
        const headers = contextualHeaders(
          options?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        const assistance = sessionStorage.getItem('plateform-impersonation');
        if (assistance && z.uuid().safeParse(assistance).success)
          headers.set('x-plateform-impersonation', assistance);
        const signal = options?.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000);
        return fetch(input, { ...options, headers, signal });
      },
    },
  });
  return instance;
}

const messages: Record<string, string> = {
  OFFLINE_QUEUE_UNREADABLE:
    'La coda locale non è leggibile. Le operazioni sono conservate: non cancellare i dati del dispositivo e richiedi assistenza.',
  PRIVACY_HOLD:
    'La prenotazione è protetta dalla conservazione. Verifica il motivo prima di rimuovere la protezione.',
  RESERVATION_STILL_ACTIVE: 'Concludi la prenotazione prima di anonimizzare i dati.',
  INVALID_PRIVACY_REQUEST: 'Controlla i dati e il motivo della richiesta.',
  INVALID_RETENTION: 'Inserisci tempi di conservazione compresi tra 1 e 3650 giorni.',
  CHAIN_SCOPE_REQUIRED: 'Questa configurazione richiede un amministratore della catena.',
  FEATURE_NOT_LICENSED: 'La funzionalità deve essere abilitata dal responsabile tecnico.',
  MULTI_VENUE_DISABLED: 'La gestione di più sedi non è abilitata.',
  LAYOUT_IN_SERVICE: 'Completa il servizio della sala prima di modificare il layout.',
  TABLE_LIMIT: 'Hai raggiunto il limite dei tavoli attivi per questa sede.',
  DISH_LIMIT: 'Hai raggiunto il limite dei piatti attivi.',
  USER_LIMIT: 'Hai raggiunto il limite degli utenti attivi.',
  DEVICE_LIMIT: 'Hai raggiunto il limite dei dispositivi autorizzati.',
  STORAGE_LIMIT: 'Lo spazio disponibile per i file è esaurito.',
  LIMIT_BELOW_CURRENT_USAGE: 'Il limite non può essere inferiore alle risorse già utilizzate.',
  PRINT_RECONCILIATION_REQUIRED:
    'Verifica il documento fisico e l’esito della stampa prima di proseguire.',
  PRINT_DEVICE_IN_USE:
    'Scollega la stampante dalle postazioni e verifica le stampe in attesa prima di archiviarla.',
  INVALID_PRINT_ENDPOINT: 'Controlla l’indirizzo HTTPS e il percorso della stampante o del bridge.',
  OFFLINE_VERIFICATION_KEY_REQUIRED:
    'Configura la chiave pubblica di verifica prima di abilitare l’uso offline.',
  OFFLINE_AUTHORIZATION_EXPIRED:
    'L’autorizzazione offline è scaduta. Riconnettiti e accedi di nuovo.',
  OFFLINE_OTHER_USER_QUEUE:
    'Questo dispositivo conserva ordini di un altro collega. Sincronizzali con il suo accesso prima di preparare l’uso offline.',
  OFFLINE_RESOURCE_ALREADY_QUEUED:
    'Questa risorsa ha già un’operazione in coda. Sincronizzala prima di proseguire.',
  OFFLINE_OPERATION_FORBIDDEN:
    'Lo snapshot non autorizza questa operazione offline. Riconnettiti e aggiorna i dati.',
  OFFLINE_ACCOUNT_ALREADY_QUEUED:
    'Questo conto ha già un ordine in coda. Sincronizzalo prima di crearne un altro.',
  INVALID_OFFLINE_SIGNATURE:
    'L’autorizzazione offline non è verificabile con le chiavi di questa installazione.',
  FORBIDDEN: 'Non hai il permesso per questa operazione.',
  VENUE_FORBIDDEN: 'Non hai accesso a questa sede.',
  RESPONSIBLE_WAITER_REQUIRED: 'L’operazione spetta al cameriere responsabile del tavolo.',
  OUT_OF_STOCK: 'Una delle pietanze è esaurita. Aggiorna l’ordine e riprova.',
  VERSION_CONFLICT: 'I dati sono cambiati su un altro dispositivo. Aggiorna la vista.',
  ACCOUNT_NOT_ORDERABLE: 'Il conto non accetta nuovi ordini.',
  ORDERING_DISABLED: 'L’ordinazione dal tavolo non è disponibile in questo momento.',
  INVALID_ITEMS: 'Il carrello non è valido o contiene troppi elementi.',
  INVALID_QUANTITY_OR_STEP: 'Controlla quantità e portate prima di inviare l’ordine.',
  ACCOUNT_NOT_SETTLED: 'Il conto ha ancora un saldo o un pagamento in attesa.',
  REGISTER_NOT_OPEN: 'Apri la cassa prima di proseguire.',
  REGISTER_FORBIDDEN: 'Questa cassa non è assegnata al tuo utente.',
  SERVICE_NOT_OPEN: 'Apri un servizio di cassa prima di registrare il pagamento.',
  INVALID_PAYMENT_AMOUNT: 'L’importo supera il saldo disponibile o non è valido.',
  INVALID_ITEM_FIELDS: 'Controlla i dati dell’ordine.',
  INGREDIENT_NOT_REMOVABLE: 'Uno degli ingredienti selezionati non può essere rimosso.',
  VARIANT_SELECTION_REQUIRED: 'Completa le varianti richieste.',
  STEP_UP_REQUIRED: 'Conferma nuovamente la tua identità per procedere.',
  FULL_AUTH_REQUIRED: 'Accedi di nuovo con identificativo e password.',
  PIN_OR_FULL_AUTH_REQUIRED: 'Sblocca la sessione con PIN o accedi di nuovo.',
  STAFF_IDENTIFIER_TAKEN: 'Questo identificativo staff è già utilizzato. Scegline uno diverso.',
  INVALID_STAFF_COMMAND:
    'Dati staff non validi. Controlla il dominio dell’identificativo e le sedi assegnate.',
  STAFF_COMMAND_PENDING: 'Esiste già una creazione o modifica staff in sospeso. Controlla le operazioni da riprendere.',
  STAFF_LIMIT: 'È stato raggiunto il limite di utenti staff attivi.',
  STAFF_COMMAND_RECOVERY_REQUIRED:
    'La creazione staff richiede un recupero. Controlla le operazioni da riprendere prima di ripetere la richiesta.',
  LOGIN_FORBIDDEN: 'L’accesso operativo non è disponibile per questo account.',
  DEVICE_REVOKED: 'Questo dispositivo è stato revocato.',
  MFA_REQUIRED: 'Completa la verifica con il codice di autenticazione.',
  CUSTOMER_SESSION_REQUIRED: 'Inserisci il codice attuale del conto per accedere.',
  TABLE_CAPACITY_INSUFFICIENT: 'Il tavolo o gruppo selezionato non ha posti sufficienti.',
  TABLE_STILL_IN_USE: 'Il tavolo è ancora in uso.',
  TABLE_GROUP_IN_SERVICE: 'Completa il servizio del gruppo prima di separare i tavoli.',
  TABLE_ALREADY_RESERVED: 'Il tavolo è già assegnato a un’altra prenotazione.',
  TARGET_TABLE_NOT_AVAILABLE: 'Il tavolo di destinazione non è disponibile.',
  SELECT_PRIMARY_TABLE: 'Seleziona il tavolo principale del gruppo.',
  INVALID_DEVICE_TOKEN: 'La registrazione del dispositivo non è valida. Contatta l’amministratore.',
  RESERVATIONS_DISABLED: 'Le prenotazioni sono disabilitate per questa sede.',
  SERVICE_UNAVAILABLE: 'Il servizio selezionato non è disponibile per questa data.',
  BOOKING_DUPLICATE:
    'Esiste già una prenotazione con questo telefono nello stesso servizio e orario. Contatta il ristorante per modificarla.',
  BOOKING_CAPACITY_REACHED:
    'La fascia selezionata non ha più disponibilità per questo numero di persone.',
  BOOKING_CLOSED: 'La fascia selezionata è chiusa alle prenotazioni.',
  BOOKING_SLOT_UNAVAILABLE: 'L’orario selezionato non è prenotabile.',
  BOOKING_DATE_UNAVAILABLE: 'La data selezionata non è prenotabile per questo servizio.',
  BOOKING_IN_PAST: 'Scegli un orario futuro.',
  NONEXISTENT_LOCAL_TIME: 'Questo orario non esiste nel fuso orario della sede. Scegline un altro.',
  CONTACT_RESTAURANT_FOR_LARGE_PARTY:
    'Per questo numero di persone è necessario contattare direttamente il ristorante.',
  INVALID_FORM_ANSWERS: 'Controlla le risposte del modulo di prenotazione.',
  FORM_REQUIRED_FIELDS: 'Completa tutti i campi obbligatori della prenotazione.',
  INVALID_FORM_OPTION: 'Una delle opzioni selezionate non è valida.',
  INVALID_FORM_NUMBER: 'Controlla i campi numerici della prenotazione.',
  INVALID_FORM_CHECKBOX: 'Controlla le selezioni della prenotazione.',
  INVALID_FORM_TEXT: 'Controlla i campi testuali della prenotazione.',
  UNKNOWN_FORM_FIELD: 'Il modulo di prenotazione è cambiato. Aggiorna la pagina e riprova.',
  PENDING_PAYMENT_RECONCILIATION_REQUIRED:
    'Verifica i pagamenti e i rimborsi in attesa prima della chiusura.',
  SERVICE_ALREADY_OPEN: 'Questa cassa ha già un servizio contabile aperto.',
  INVALID_RECONCILIATION: 'Controlla il conteggio reale di tutte le casse del servizio.',
  REGISTER_SERVICE_UNRECONCILED:
    'Completa la quadratura del servizio prima di archiviare la cassa.',
  INVALID_REFUND_AMOUNT: 'Il rimborso supera l’importo ancora rimborsabile o non è valido.',
  PAYMENT_NOT_REFUNDABLE: 'Lo stato attuale del pagamento non consente questo rimborso.',
  REFUND_WORKFLOW_REQUIRED: 'Questo pagamento richiede il flusso di rimborso autorizzato.',
  REASON_REQUIRED: 'Inserisci un motivo sufficientemente dettagliato per la correzione.',
  IDEMPOTENCY_MISMATCH:
    'Questa richiesta è già stata inviata con dati diversi. Aggiorna lo storico per verificarne l’esito.',
  ACCOUNT_CLOSED: 'Il conto è già chiuso. Aggiorna lo storico prima di procedere.',
  PAYMENT_METHOD_UNAVAILABLE: 'Il metodo di pagamento non è attivo per questa cassa e sede.',
  INVALID_FILTER: 'Controlla i filtri e l’intervallo delle date.',
  DISCOUNTS_DISABLED: 'Questo tipo di riduzione è disabilitato per la sede.',
  DISCOUNT_EXCEEDS_UNPAID:
    'La riduzione deve essere positiva e non può superare il saldo ancora da pagare.',
  INVALID_DISCOUNT: 'Controlla il tipo, l’importo e i prodotti della riduzione.',
  SETTLED_ITEM_REQUIRES_CORRECTION:
    'Il prodotto è già saldato. Usa il flusso di rettifica autorizzata.',
  ITEM_ALREADY_ALLOCATED:
    'Alcuni prodotti selezionati sono già pagati o in attesa di esito. Aggiorna il conto.',
  ALLOCATION_AMOUNT_MISMATCH:
    'Il residuo dei prodotti è cambiato. Aggiorna il conto e verifica l’importo.',
  PAYMENT_METHOD_UNLICENSED:
    'Il metodo di pagamento online non è abilitato per questa installazione.',
  PAYMENT_NOT_PENDING:
    'Questo pagamento non è più in attesa. Aggiorna lo storico prima di riprovare.',
  INVALID_PROVIDER_METHOD: 'Questo pagamento non usa un provider online supportato.',
  INVALID_PROVIDER_REFUND:
    'Il rimborso online non è disponibile nello stato attuale del pagamento.',
  OPERATION_IN_PROGRESS:
    'La verifica del provider è già in corso. Attendi qualche istante e riprova.',
  PROVIDER_RECONCILIATION_REQUIRED:
    'L’esito del provider richiede una verifica manuale prima di poter riprovare il pagamento.',
  PROVIDER_REQUEST_FAILED:
    'Il provider di pagamento non ha risposto correttamente. L’operazione resta in attesa finché l’esito non viene verificato.',
};

export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    readonly requestId: string,
    humanMessage: string,
  ) {
    super(humanMessage);
    this.name = 'ApplicationError';
  }
}

export function safeError(
  error: unknown,
  requestId: string = crypto.randomUUID(),
): ApplicationError {
  if (error instanceof ApplicationError) return error;
  const parsed = z.object({ message: z.string() }).safeParse(error);
  const code = parsed.success
    ? Object.keys(messages).find((key) => parsed.data.message === key)
    : undefined;
  return new ApplicationError(
    code ?? 'REQUEST_FAILED',
    requestId,
    code
      ? messages[code]!
      : 'Operazione non completata. Verifica la connessione e aggiorna i dati prima di riprovare.',
  );
}

// Edge Functions return a reviewed error code plus a server-generated request ID.
// Decode this structured response instead of disguising validation failures as connectivity issues.
export async function safeEdgeError(error: unknown): Promise<ApplicationError> {
  const context =
    error !== null && typeof error === 'object' && 'context' in error ? error.context : null;
  if (context instanceof Response) {
    const payload: unknown = await context.clone().json().catch(() => null);
    const parsed = z
      .object({ code: z.string(), request_id: z.string().optional() })
      .safeParse(payload);
    if (parsed.success && Object.prototype.hasOwnProperty.call(messages, parsed.data.code)) {
      return new ApplicationError(
        parsed.data.code,
        parsed.data.request_id ?? crypto.randomUUID(),
        messages[parsed.data.code]!,
      );
    }
  }
  return safeError(error);
}

export async function rpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!navigator.onLine && ['get_public_menu', 'get_account_workspace'].includes(name)) {
    const cached = await cachedRpc(name, args, schema);
    if (cached !== undefined) return cached;
    throw new ApplicationError(
      'OFFLINE_CACHE_UNAVAILABLE',
      crypto.randomUUID(),
      'Questi dati non sono disponibili offline.',
    );
  }
  const requestId = crypto.randomUUID();
  const { data, error } = await client().rpc(name, args).setHeader('x-request-id', requestId);
  if (error) throw safeError(error, requestId);
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ApplicationError(
      'INVALID_RESPONSE',
      requestId,
      'La risposta ricevuta non è valida. Aggiorna la pagina.',
    );
  if (
    location.pathname.startsWith(new URL(environment().staffBaseUrl).pathname) &&
    location.origin === new URL(environment().staffBaseUrl).origin
  )
    await cacheRpc(name, args, parsed.data);
  return parsed.data;
}

export async function readRows<T>(
  table: string,
  schema: z.ZodType<T>,
  venue?: string,
  filters: Record<string, string | string[] | null> = {},
): Promise<T[]> {
  const relationTables = new Set([
    'dish_ingredients',
    'dish_dietary_tags',
    'ingredient_allergens',
    'venue_dish_settings',
    'dish_station_assignments',
    'service_booking_rules',
    'staff_venue_assignments',
    'station_staff_assignments',
    'cashier_assignments',
  ]);
  if (relationTables.has(table)) {
    let query = client().from(table).select('*').limit(1001);
    if (venue) query = query.eq('venue_id', venue);
    for (const [key, value] of Object.entries(filters))
      query = Array.isArray(value)
        ? query.in(key, value)
        : value === null
          ? query.is(key, null)
          : query.eq(key, value);
    const { data, error } = await query;
    if (error) throw safeError(error);
    const result = z.array(schema).parse(data);
    if (result.length > 1000)
      throw new ApplicationError(
        'FILTER_REQUIRED',
        crypto.randomUUID(),
        'Restringi la ricerca per caricare questi dati.',
      );
    return result;
  }
  const rows: T[] = [];
  let after: string | null = null;
  do {
    const page: { rows: T[]; next: string | null } = await readPage<T>(table, schema, {
      ...(venue ? { venue } : {}),
      filters,
      after,
      limit: 200,
    });
    rows.push(...page.rows);
    after = page.next;
  } while (after);
  return rows;
}

export async function readPage<T>(
  table: string,
  schema: z.ZodType<T>,
  options: {
    venue?: string;
    filters?: Record<string, string | string[] | null>;
    after?: string | null;
    limit?: number;
  } = {},
): Promise<{ rows: T[]; next: string | null }> {
  const key = table === 'feature_flags' ? 'name' : 'id';
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid page size');
  const requestId = crypto.randomUUID();
  let query = client()
    .from(table)
    .select('*')
    .order(key)
    .limit(limit + 1)
    .setHeader('x-request-id', requestId);
  if (options.venue) query = query.eq('venue_id', options.venue);
  if (options.after) query = query.gt(key, options.after);
  for (const [field, value] of Object.entries(options.filters ?? {}))
    query = Array.isArray(value)
      ? query.in(field, value)
      : value === null
        ? query.is(field, null)
        : query.eq(field, value);
  const { data, error } = await query;
  if (error) throw safeError(error, requestId);
  const raw = z.array(z.record(z.string(), z.unknown())).parse(data);
  const page = raw.slice(0, limit);
  return {
    rows: z.array(schema).parse(page),
    next: raw.length > limit ? z.string().parse(page.at(-1)?.[key]) : null,
  };
}
