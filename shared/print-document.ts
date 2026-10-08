// Shared by the browser, signing endpoint and local bridge. Contains no credentials or DOM APIs.
export interface PrintPayload {
  restaurant: string;
  legal_name?: string | null | undefined;
  logo?: string | null | undefined;
  venue?: string | undefined;
  address?: string | undefined;
  timezone?: string | undefined;
  at: string;
  account: string;
  table: string;
  document: string;
  reprint_of?: string | undefined;
  lines: {
    name: string;
    quantity: number;
    unit_price_cents?: number | undefined;
    discount_cents?: number | undefined;
    total_cents?: number | undefined;
    step?: number | undefined;
    removed?: string[] | null | undefined;
    variants?: { group: string; option: string }[] | null | undefined;
  }[];
  balance?:
    | {
        total_cents: number;
        discount_cents: number;
        gross_cents?: number | undefined;
        paid_cents?: number | undefined;
        pending_cents?: number | undefined;
        available_cents?: number | undefined;
        remaining_cents?: number | undefined;
      }
    | undefined;
  payments?: { method: string; amount_cents: number; tip_cents: number }[] | undefined;
  refunds?: { method: string; amount_cents: number }[] | undefined;
}
const money = (n: number) =>
  new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n / 100);
export function printLines(payload: PrintPayload): string[] {
  const lines = [
    payload.restaurant,
    payload.venue ?? '',
    payload.address ?? '',
    payload.document,
    payload.reprint_of ? 'RISTAMPA' : '',
    new Date(payload.at).toLocaleString('it-IT', { timeZone: payload.timezone ?? 'Europe/Rome' }),
    `Tavolo: ${payload.table}`,
    `Conto: ${payload.account}`,
    '',
  ];
  for (const item of payload.lines) {
    lines.push(
      `${item.quantity} × ${item.name}${item.total_cents === undefined ? '' : `  ${money(item.total_cents)}`}`,
    );
    if (item.step) lines.push(`Step ${item.step}`);
    if (item.discount_cents) lines.push(`Riduzione ${money(item.discount_cents)}`);
    for (const removed of item.removed ?? []) lines.push(`SENZA ${removed}`);
    for (const variant of item.variants ?? []) lines.push(`${variant.group}: ${variant.option}`);
  }
  if (payload.balance)
    lines.push(
      '',
      `Riduzioni: ${money(payload.balance.discount_cents)}`,
      `Totale: ${money(payload.balance.total_cents)}`,
    );
  for (const pay of payload.payments ?? [])
    lines.push(
      `${pay.method}: ${money(pay.amount_cents)}`,
      `Mancia separata: ${money(pay.tip_cents)}`,
    );
  for (const refund of payload.refunds ?? [])
    lines.push(`Rimborso ${refund.method}: -${money(refund.amount_cents)}`);
  return lines.filter((line, index) => line !== '' || index > 6);
}
const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export function eposDocument(payload: PrintPayload): string {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print"><text lang="it"/><text>${xml(printLines(payload).join('\n'))}\n</text><feed line="3"/><cut type="feed"/></epos-print></s:Body></s:Envelope>`;
}
