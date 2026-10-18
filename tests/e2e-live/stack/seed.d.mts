export interface StaffMember {
  email: string;
  name: string;
  role: 'WAITER' | 'KITCHEN_STAFF' | 'PASS' | 'CASHIER' | 'ADMIN' | 'KITCHEN_ADMIN';
  landing: string;
}
export const stack: { gateway: string; dbUrl: string; jwtSecret: string };
export const anonKey: string;
export const serviceKey: string;
export const password: string;
export const staff: {
  waiter: StaffMember;
  kitchen: StaffMember;
  pass: StaffMember;
  cashier: StaffMember;
  admin: StaffMember;
  kitchenAdmin: StaffMember;
};
export const ids: Record<
  | 'venue'
  | 'room'
  | 'layout'
  | 'zone'
  | 'table1'
  | 'table2'
  | 'station'
  | 'category'
  | 'carbonara'
  | 'tiramisu'
  | 'register',
  string
>;
export function sign(payload: Record<string, unknown>): string;
export function sql(text: string): string;
export function seed(): Promise<Record<keyof typeof staff, string>>;
