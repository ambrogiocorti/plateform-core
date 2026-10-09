export function cleanInstallPlan(root?: string): Promise<{
  bootstrap: string;
  postlude: string;
  bootstrapManifest: {
    version: number;
    bootstrap_sha256: string;
    postlude_sha256: string;
    tables: string[];
    routines: string[];
  };
  releaseTestCatalog: { key: string; category: string; required: boolean; description: string }[];
  migrations: { version: string; name: string; filename: string; sha256: string; sql: string }[];
  inventorySha256: string;
}>;
