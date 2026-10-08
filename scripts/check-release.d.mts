export const requiredIntegrationChecks: string[];
export const requiredDocuments: string[];
export function roadmapProblems(roadmap: unknown): string[];
export function releaseProblems(
  matrix: { sections: { section: number; status: string }[] },
  evidence: Record<string, unknown>,
  digest: string,
  now?: number,
): string[];
export function sourceDigest(root?: string): Promise<string>;
export function checkRelease(
  root?: string,
  evidencePath?: string,
): Promise<{ evidence: Record<string, unknown>; digest: string }>;
