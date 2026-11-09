// Contract shared by the venue hub (tools/venue-hub) and the staff client.
// It is the exhaustive list of operations a paired LAN device may perform on
// the hub. Anything else needs the cloud and a full authentication.
// Parameter names are the SQL parameter names, so calls use PostgreSQL named
// notation and an unexpected key is refused before reaching the database.

export type LanRpc = { params: readonly string[]; write: boolean };

export const LAN_RPCS: Readonly<Record<string, LanRpc>> = {
  create_account: { params: ['p_table', 'p_name', 'p_covers', 'p_note', 'p_key'], write: true },
  create_order: { params: ['p_account', 'p_items', 'p_key', 'p_version'], write: true },
  get_kitchen_board: { params: ['p_venue'], write: false },
  transition_order_item: { params: ['p_item', 'p_status', 'p_version'], write: true },
  mark_step_ready: { params: ['p_step'], write: true },
  deliver_step: { params: ['p_step', 'p_served'], write: true },
  open_service_session: {
    params: ['p_venue', 'p_service', 'p_register', 'p_float', 'p_key'],
    write: true,
  },
  create_payment: {
    params: [
      'p_account',
      'p_register',
      'p_amount',
      'p_tip',
      'p_method',
      'p_key',
      'p_items',
      'p_share',
    ],
    write: true,
  },
  confirm_manual_payment: { params: ['p_payment', 'p_success'], write: true },
  get_account_balance: { params: ['p_account'], write: false },
  close_account: { params: ['p_account'], write: true },
};

// Tables readable through the hub, always under the caller's RLS policies.
export const LAN_TABLES: ReadonlySet<string> = new Set([
  'accounts',
  'orders',
  'tables',
  'payments',
  'rooms',
  'zones',
  'room_layouts',
  'stations',
  'categories',
  'dishes',
  'venue_dish_settings',
  'cash_registers',
  'cashier_assignments',
  'step_deliveries',
]);

// Payment methods the hub may record without a provider confirmation. Online
// providers (Stripe, Satispay API, refunds) are refused on the LAN (ADR-0001).
export const LAN_PAYMENT_METHODS: ReadonlySet<string> = new Set([
  'CASH',
  'CARD_POS',
  'SATISPAY_POS',
]);

export const LAN_FILTER_COLUMN = /^[a-z_][a-z0-9_]{0,62}$/;

export function isLanRpc(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LAN_RPCS, name);
}
