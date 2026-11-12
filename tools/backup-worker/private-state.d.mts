export const DURABLE_PRIVATE_TABLES: string[];
export const EPHEMERAL_PRIVATE_TABLES: string[];
export const EPHEMERAL_AUTH_TABLES: string[];
export function durablePrivateStateSql(): string;
export function securityStateSql(): string;
export function sanitizeSecuritySql(): string;
