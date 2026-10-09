export interface InstallerConfig {
  project_ref: string;
  token_sha256: string;
  created_at_ms: number;
  expires_at_ms: number;
  inventory_sha256: string;
  payload_sha256: string;
  source_commit: string;
}
export interface InstallerPayload {
  bootstrap: string;
  bootstrap_sha256: string;
  postlude: string;
  postlude_sha256: string;
  barrier: string;
  barrier_sha256: string;
  migrations: Array<{
    version: string;
    name: string;
    filename: string;
    sql: string;
    sha256: string;
  }>;
}
export interface InstallerConnection {
  query(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}
export function sha256(text: string): Promise<string>;
export function verifiedDatabaseURL(
  config: InstallerConfig,
  env: Record<string, string | undefined>,
  now: number,
): string;
export function verifyPayload(payload: InstallerPayload, config: InstallerConfig): Promise<void>;
export function verifiedPrefix(
  connection: InstallerConnection,
  payload: InstallerPayload,
): Promise<number>;
export function createInstallerHandler(options: {
  config: InstallerConfig;
  payload: InstallerPayload;
  env: Record<string, string | undefined>;
  connect(url: string): Promise<InstallerConnection>;
  now?: () => number;
}): (request: Request) => Promise<Response>;
