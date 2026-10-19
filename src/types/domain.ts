import { z } from 'zod';

export const userRoles = [
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
] as const;
export const userRoleSchema = z.enum(userRoles);
export type UserRole = z.infer<typeof userRoleSchema>;
export type UserScope = 'CHAIN' | 'VENUE';
export type VenueId = string & { readonly __venueId: unique symbol };
export type ReservationStatus =
  'REQUESTED' | 'RESERVED' | 'ARRIVED' | 'SEATED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';
export type TableStatus =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'ARRIVING'
  | 'OCCUPIED'
  | 'ORDERING'
  | 'WAITING_SERVICE'
  | 'WAITING_BILL'
  | 'PAYMENT'
  | 'TO_RESET';
export type AccountStatus =
  'OPEN' | 'BILL_REQUESTED' | 'AT_CASHIER' | 'PARTIALLY_PAID' | 'PAID' | 'CLOSED';
export type OrderStatus = 'RECEIVED' | 'IN_PREPARATION' | 'READY' | 'SERVED' | 'CANCELLED';
export type OrderItemStatus = OrderStatus;
export type PaymentStatus =
  'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
export type RefundStatus =
  'REQUESTED' | 'APPROVED' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'REJECTED';
export type PrintJobStatus = 'QUEUED' | 'SENT' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type SyncStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'CONFLICT' | 'REJECTED' | 'RESOLVED';
export type IncidentSeverity = 'INFO' | 'WARNING' | 'DEGRADED' | 'INCIDENT' | 'CRITICAL';
export type NotificationStatus = 'NEW' | 'ACKNOWLEDGED' | 'RESOLVED' | 'EXPIRED';
export type WaiterMode = 'TABLE' | 'ZONE' | 'RUNNER';

export const staffProfileSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  role: userRoleSchema,
  scope: z.enum(['CHAIN', 'VENUE']),
  active: z.boolean(),
  version: z.number(),
});
export type StaffProfile = z.infer<typeof staffProfileSchema>;

export const menuDishSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  // Optional in the catalog: a dish saved without one comes back as null.
  description: z
    .string()
    .nullable()
    .transform((value) => value ?? ''),
  image_path: z.string().nullable(),
  beverage: z.boolean(),
  category_id: z.uuid(),
  category_name: z.string(),
  price_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  availability: z.number().int().nonnegative().nullable(),
  ingredients: z.array(z.object({ id: z.uuid(), name: z.string(), removable: z.boolean() })),
  allergens: z.array(z.object({ code: z.string(), name: z.string() })),
  dietary_tags: z.array(z.object({ code: z.string(), label: z.string() })),
  variant_groups: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      required: z.boolean(),
      max_selections: z.number().int().positive(),
      options: z.array(z.object({ id: z.uuid(), label: z.string() })),
    }),
  ),
});
export type MenuDish = z.infer<typeof menuDishSchema>;
export const orderLineSchema = z
  .object({
    dish_id: z.uuid(),
    quantity: z.number().int().min(1).max(999),
    step: z.number().int().min(1).max(99),
    removed_ingredients: z.array(z.uuid()).max(100),
    variant_options: z.array(z.uuid()).max(100),
  })
  .strict();
export type OrderLine = z.infer<typeof orderLineSchema>;

export const venueSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  address: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  opening_hours: z.record(z.string(), z.unknown()),
  timezone: z.string(),
  currency: z.string(),
  locale: z.string(),
  reservations_enabled: z.boolean().optional(),
});
export type Venue = z.infer<typeof venueSchema>;
export const publicSiteSchema = z.object({
  name: z.string(),
  branding: z.record(z.string(), z.unknown()),
  content: z.record(z.string(), z.unknown()),
  contact: z.record(z.string(), z.unknown()),
  multi_venue: z.boolean(),
  venues: z.array(venueSchema),
});
export type PublicSite = z.infer<typeof publicSiteSchema>;
