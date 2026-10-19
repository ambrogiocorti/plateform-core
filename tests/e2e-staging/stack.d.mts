import type { StaffMember } from '../e2e-live/stack/seed.mjs';

export { staff, ids, fixtureSql } from '../e2e-live/stack/seed.mjs';
export const admin: Omit<StaffMember, 'role'> & { role: 'ADMIN' };
export const ref: string;
export const supabaseUrl: string;
export const password: string;
export function sql(text: string): string;
export function anonKey(): string;
export function seed(): Promise<Record<string, string>>;
