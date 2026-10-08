import { z } from 'zod';
export const printPayloadSchema = z.object({
  restaurant: z.string(),
  legal_name: z.string().nullable().optional(),
  logo: z.string().nullable().optional(),
  venue: z.string().optional(),
  address: z.string().optional(),
  timezone: z.string().optional(),
  at: z.string(),
  account: z.string(),
  table: z.string(),
  document: z.string(),
  reprint_of: z.uuid().optional(),
  lines: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().int(),
      unit_price_cents: z.number().int().optional(),
      discount_cents: z.number().int().optional(),
      total_cents: z.number().int().optional(),
      step: z.number().int().optional(),
      removed: z.array(z.string()).nullable().optional(),
      variants: z
        .array(z.object({ group: z.string(), option: z.string() }))
        .nullable()
        .optional(),
    }),
  ),
  balance: z
    .object({
      total_cents: z.number().int(),
      discount_cents: z.number().int(),
      gross_cents: z.number().int().optional(),
      paid_cents: z.number().int().optional(),
      pending_cents: z.number().int().optional(),
      available_cents: z.number().int().optional(),
      remaining_cents: z.number().int().optional(),
    })
    .optional(),
  payments: z
    .array(
      z.object({ method: z.string(), amount_cents: z.number().int(), tip_cents: z.number().int() }),
    )
    .optional(),
  refunds: z
    .array(z.object({ method: z.string(), amount_cents: z.number().int() }))
    .optional(),
});
export type PrintPayload = z.infer<typeof printPayloadSchema>;
export { printLines, eposDocument } from '../../shared/print-document';
export function printerEndpoint(value: string, driver: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('INVALID_PRINT_ENDPOINT');
  if (driver === 'EPOS' && url.pathname !== '/cgi-bin/epos/service.cgi')
    throw new Error('INVALID_PRINT_ENDPOINT');
  if (driver === 'BRIDGE' && url.pathname !== '/v1/print')
    throw new Error('INVALID_PRINT_ENDPOINT');
  return url;
}
