import { z } from 'zod';

export const accountSchema = z.object({
  id: z.uuid(),
  venue_id: z.uuid(),
  account_name: z.string(),
  table_id: z.uuid(),
  table_name: z.string(),
  covers: z.number().int(),
  status: z.string(),
  version: z.number().int(),
  floor_released_at: z.string().nullable(),
  unserved_items: z.number().int(),
});
export const balanceSchema = z.object({
  gross_cents: z.number().int(),
  discount_cents: z.number().int(),
  total_cents: z.number().int(),
  paid_cents: z.number().int(),
  pending_cents: z.number().int(),
  remaining_cents: z.number().int(),
  available_cents: z.number().int(),
});
export const accountOrderSchema = z.object({
  id: z.uuid(),
  version: z.number().int().optional(),
  created_at: z.string(),
  status: z.string(),
  items: z.array(
    z.object({
      id: z.uuid(),
      dish_name: z.string(),
      quantity: z.number().int(),
      unit_price_cents: z.number().int(),
      status: z.string(),
    }),
  ),
});
export const accountWorkspaceSchema = z.object({
  account: accountSchema,
  balance: balanceSchema,
  orders: z.array(accountOrderSchema),
  has_more: z.boolean(),
});
export const paymentRegisterSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.string(),
  service_session_id: z.uuid(),
  payment_methods: z.array(z.string()),
});
export type Account = z.infer<typeof accountSchema>;
export type AccountBalance = z.infer<typeof balanceSchema>;
