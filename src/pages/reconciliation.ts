import { z } from 'zod';
import { rpc } from '../api/client';
import { stepUp } from '../auth/step-up';
import { button, dialog, el, field, toast } from '../components/dom';
import { formatMoney, parseMoney } from '../services/money';
import type { StaffContext } from './staff-context';

const methodSchema = z.object({
  method: z.string(),
  amount_cents: z.number().int(),
  tip_cents: z.number().int(),
  entries: z.number().int(),
});
const registerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
  opening_float_cents: z.number().int(),
  cash_theoretical_cents: z.number().int(),
  amount_cents: z.number().int(),
  tip_cents: z.number().int(),
  refund_cents: z.number().int(),
  refund_tip_cents: z.number().int(),
  methods: z.array(methodSchema),
});
const actualsSchema = z.array(
  z.object({ cash_register_id: z.uuid(), cash_actual_cents: z.number().int() }),
);
const snapshotSchema = z.object({
  registers: z.array(registerSchema),
  pending_payments: z.number().int(),
  pending_refunds: z.number().int(),
  open_accounts: z.number().int(),
  closed_accounts: z.number().int(),
});
const pendingSchema = snapshotSchema.extend({
  status: z.enum(['OPEN', 'RECONCILING', 'AWAITING_APPROVAL']),
  approval_request: z
    .object({ id: z.uuid(), actuals: actualsSchema, snapshot: snapshotSchema })
    .nullable(),
});
const closedSchema = z.object({
  status: z.literal('CLOSED'),
  closed_at: z.string(),
  reconciliations: z.array(
    z.object({
      id: z.uuid(),
      cash_actual_cents: z.number().int(),
      cash_theoretical_cents: z.number().int(),
      difference_cents: z.number().int(),
      authorized_by: z.uuid().nullable(),
      snapshot: snapshotSchema,
    }),
  ),
});

export async function reconciliationDialog(context: StaffContext, session: string): Promise<void> {
  const result = await rpc(
    'get_service_reconciliation',
    { p_session: session },
    z.union([pendingSchema, closedSchema]),
  );
  const popup = dialog(
    result.status === 'CLOSED' ? 'Quadratura conclusa' : 'Chiudi servizio contabile',
  );
  const money = (cents: number) =>
    formatMoney(cents, context.venue?.currency, context.venue?.locale);
  if (result.status === 'CLOSED') {
    popup.append(el('p', {}, `Chiuso il ${new Date(result.closed_at).toLocaleString('it-IT')}`));
    for (const record of result.reconciliations)
      popup.append(
        el(
          'section',
          { class: 'card stack' },
          el('p', {}, `Contante teorico ${money(record.cash_theoretical_cents)}`),
          el('p', {}, `Contante reale ${money(record.cash_actual_cents)}`),
          el('strong', {}, `Differenza ${money(record.difference_cents)}`),
          record.authorized_by ? el('p', {}, 'Differenza approvata da un amministratore.') : null,
          el(
            'p',
            { class: 'muted' },
            'Snapshot contabile immutabile. Gli eventuali movimenti successivi sono registrati in un nuovo servizio.',
          ),
        ),
      );
    return;
  }
  const snapshot = result.approval_request?.snapshot ?? result;
  popup.append(
    el(
      'p',
      {},
      `${snapshot.closed_accounts} conti chiusi · ${snapshot.open_accounts} conti ancora aperti`,
    ),
  );
  if (snapshot.open_accounts)
    popup.append(
      el(
        'p',
        { class: 'muted' },
        'I conti ancora aperti restano disponibili per il servizio successivo.',
      ),
    );
  const inputs = new Map<string, HTMLInputElement>();
  for (const register of snapshot.registers) {
    const card = el(
      'section',
      { class: 'card stack' },
      el('h3', {}, `${register.name} · ${register.code}`),
      el('p', {}, `Fondo iniziale ${money(register.opening_float_cents)}`),
      el(
        'p',
        {},
        `Incassi netti ${money(register.amount_cents)} · Mance ${money(register.tip_cents)}`,
      ),
      el(
        'p',
        {},
        `Rimborsi ${money(register.refund_cents)} · Mance rimborsate ${money(register.refund_tip_cents)}`,
      ),
      ...register.methods.map((method) =>
        el(
          'p',
          {},
          `${method.method.replaceAll('_', ' ')}: ${money(method.amount_cents)} + ${money(method.tip_cents)} mance`,
        ),
      ),
      el('strong', {}, `Contante teorico ${money(register.cash_theoretical_cents)}`),
    );
    if (result.approval_request) {
      const actual = result.approval_request.actuals.find(
        (entry) => entry.cash_register_id === register.id,
      )?.cash_actual_cents;
      if (actual !== undefined)
        card.append(
          el('p', {}, `Contante contato ${money(actual)}`),
          el('strong', {}, `Differenza ${money(actual - register.cash_theoretical_cents)}`),
        );
    } else {
      const actual = field('Contante reale contato', 'cash-actual');
      actual.input.required = true;
      actual.input.inputMode = 'decimal';
      actual.input.placeholder = '0,00';
      inputs.set(register.id, actual.input);
      card.append(actual.root);
    }
    popup.append(card);
  }
  if (result.approval_request) {
    popup.append(
      el(
        'p',
        { role: 'status' },
        'La differenza richiede approvazione Admin. Il servizio resta sospeso fino alla decisione.',
      ),
    );
    if (context.profile.role === 'ADMIN') {
      const note = field('Motivo della decisione', 'decision');
      note.input.required = true;
      note.input.minLength = 3;
      note.input.maxLength = 2000;
      popup.append(note.root);
      for (const approve of [true, false]) {
        const key = crypto.randomUUID();
        popup.append(
          button(
            approve ? 'Approva e chiudi servizio' : 'Rifiuta e riapri servizio',
            async () => {
              if (!note.input.reportValidity()) return;
              const grant = await stepUp('CASH_RECONCILIATION', result.approval_request!.id);
              await rpc(
                'resolve_service_reconciliation',
                {
                  p_request: result.approval_request!.id,
                  p_approve: approve,
                  p_reason: note.input.value,
                  p_grant: grant,
                  p_key: key,
                },
                z.object({ id: z.uuid(), status: z.string() }),
              );
              popup.close();
              toast(
                approve
                  ? 'Servizio chiuso con approvazione.'
                  : 'Servizio riaperto per la verifica.',
              );
              context.navigate('/cassa');
            },
            approve ? 'primary' : 'secondary',
          ),
        );
      }
    }
    return;
  }
  if (snapshot.pending_payments || snapshot.pending_refunds) {
    popup.append(
      el(
        'p',
        { role: 'alert' },
        `Prima della chiusura verifica ${snapshot.pending_payments} pagamenti e ${snapshot.pending_refunds} rimborsi in attesa.`,
      ),
    );
    return;
  }
  const key = crypto.randomUUID();
  popup.append(
    button('Conferma conteggio e chiudi', async () => {
      const actuals = [];
      for (const [id, input] of inputs) {
        if (!input.reportValidity()) return;
        actuals.push({ cash_register_id: id, cash_actual_cents: Number(parseMoney(input.value)) });
      }
      const response = await rpc(
        'request_service_close',
        { p_session: session, p_actuals: actuals, p_key: key },
        z.object({ id: z.uuid(), status: z.string() }),
      );
      popup.close();
      toast(
        response.status === 'CLOSED'
          ? 'Servizio chiuso e quadratura salvata.'
          : 'Differenza inviata all’Admin per approvazione.',
      );
      context.navigate('/cassa');
    }),
  );
}
