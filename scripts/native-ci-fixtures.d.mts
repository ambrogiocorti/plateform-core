export const nativeActors: Array<{ name: string; role?: string; scope?: string; venue?: string }>;
export function nativeFixtureIDs(): Record<string, string>;
export function nativeUUID(value: unknown): string;
export function nativeFixtureSQL(
  ids: Record<string, string>,
  users: Record<string, string>,
): string;
