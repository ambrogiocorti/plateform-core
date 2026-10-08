import { el } from '../components/dom';
import type { PrintPayload } from './document';

const money = (value: number) =>
  new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(value / 100);

export function isPdfOutput(configuration: Record<string, unknown> | undefined): boolean {
  return configuration?.output === 'PDF';
}

export function invoiceDocument(payload: PrintPayload, logo?: string | null): HTMLElement {
  const issuedAt = new Date(payload.at);
  const timezone = payload.timezone ?? 'Europe/Rome';
  const date = issuedAt.toLocaleDateString('it-IT', { timeZone: timezone });
  const time = issuedAt.toLocaleTimeString('it-IT', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  });

  const issuer = el(
    'section',
    { class: 'invoice-party' },
    el('p', { class: 'invoice-kicker' }, 'Emittente'),
    el('strong', {}, payload.legal_name || payload.restaurant),
    payload.legal_name && payload.legal_name !== payload.restaurant
      ? el('p', {}, payload.restaurant)
      : null,
    payload.venue ? el('p', {}, payload.venue) : null,
    payload.address ? el('p', {}, payload.address) : null,
  );

  const reference = el(
    'section',
    { class: 'invoice-party' },
    el('p', { class: 'invoice-kicker' }, 'Riferimenti'),
    el('p', {}, `Conto: ${payload.account}`),
    el('p', {}, `Tavolo: ${payload.table}`),
    el('p', {}, `Data: ${date}`),
    el('p', {}, `Ora: ${time}`),
  );

  const header = el(
    'div',
    { class: 'invoice-header' },
    el(
      'div',
      { class: 'invoice-brand' },
      logo ? el('img', { src: logo, alt: payload.restaurant, class: 'invoice-logo' }) : null,
      el(
        'div',
        {},
        el('p', { class: 'invoice-kicker' }, 'Plateform'),
        el('h1', {}, 'Documento PDF'),
        el('p', { class: 'invoice-subtitle' }, 'Formato fattura - copia di cortesia'),
      ),
    ),
    el('span', { class: 'invoice-non-fiscal' }, 'NON FISCALE'),
  );

  const table = el(
    'table',
    { class: 'invoice-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, 'Q.tà'),
        el('th', {}, 'Descrizione'),
        el('th', { class: 'numeric' }, 'Prezzo'),
        el('th', { class: 'numeric' }, 'Riduzioni'),
        el('th', { class: 'numeric' }, 'Totale'),
      ),
    ),
    el(
      'tbody',
      {},
      ...(payload.lines.length
        ? payload.lines.map((line) =>
            el(
              'tr',
              {},
              el('td', {}, String(line.quantity)),
              el('td', {}, line.name),
              el(
                'td',
                { class: 'numeric' },
                line.unit_price_cents === undefined ? '-' : money(line.unit_price_cents),
              ),
              el(
                'td',
                { class: 'numeric' },
                line.discount_cents ? money(line.discount_cents) : '-',
              ),
              el(
                'td',
                { class: 'numeric' },
                line.total_cents === undefined ? '-' : money(line.total_cents),
              ),
            ),
          )
        : [
            el(
              'tr',
              {},
              el('td', { colspan: '5', class: 'invoice-empty-row' }, 'Nessuna voce attiva.'),
            ),
          ]),
    ),
  );

  const totals = payload.balance
    ? el(
        'section',
        { class: 'invoice-totals' },
        el('div', {}, el('span', {}, 'Riduzioni'), el('strong', {}, money(payload.balance.discount_cents))),
        el('div', {}, el('span', {}, 'Totale'), el('strong', {}, money(payload.balance.total_cents))),
        payload.balance.paid_cents !== undefined
          ? el('div', {}, el('span', {}, 'Pagato'), el('strong', {}, money(payload.balance.paid_cents)))
          : null,
        payload.balance.remaining_cents !== undefined
          ? el(
              'div',
              {},
              el('span', {}, 'Residuo'),
              el('strong', {}, money(payload.balance.remaining_cents)),
            )
          : null,
      )
    : null;

  const payments = el(
    'section',
    { class: 'invoice-payments' },
    el('h2', {}, 'Pagamenti e rimborsi'),
    ...(payload.payments?.length
      ? payload.payments.flatMap((payment) => [
          el(
            'div',
            { class: 'invoice-payment-line' },
            el('span', {}, payment.method),
            el('strong', {}, money(payment.amount_cents)),
          ),
          payment.tip_cents
            ? el(
                'div',
                { class: 'invoice-payment-line muted' },
                el('span', {}, 'Mancia separata'),
                el('span', {}, money(payment.tip_cents)),
              )
            : null,
        ])
      : [el('p', { class: 'muted' }, 'Nessun pagamento netto registrato.')]),
    ...(payload.refunds ?? []).map((refund) =>
      el(
        'div',
        { class: 'invoice-payment-line' },
        el('span', {}, `Rimborso ${refund.method}`),
        el('strong', {}, `-${money(refund.amount_cents)}`),
      ),
    ),
  );

  return el(
    'section',
    { class: 'invoice-document' },
    header,
    el('div', { class: 'invoice-parties' }, issuer, reference),
    table,
    totals,
    payments,
    el(
      'footer',
      { class: 'invoice-footer' },
      el(
        'strong',
        {},
        'Documento non fiscale. Non costituisce fattura elettronica né documento commerciale fiscale.',
      ),
      el(
        'p',
        {},
        'Per l’emissione fiscale in Italia è necessario il documento elettronico XML trasmesso tramite Sistema di Interscambio (SdI).',
      ),
    ),
  );
}
