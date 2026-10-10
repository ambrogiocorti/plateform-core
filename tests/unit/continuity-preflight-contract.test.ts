import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(path, 'utf8');
const backup = source('supabase/functions/continuity-backup-worker/index.ts');
const replica = source('supabase/functions/continuity-replica-receiver/index.ts');

describe('continuity P0 source ordering contract', () => {
  it('checks for runnable work before remote preflight', () => {
    expect(backup.indexOf('leaseCutoff')).toBeGreaterThan(-1);
    expect(backup.indexOf('leaseCutoff')).toBeLessThan(
      backup.search(/action:\s*['"]preflight['"]/),
    );
  });

  it('checks the authenticated replica before claiming or snapshotting', () => {
    const probe = backup.search(/action:\s*['"]preflight['"]/);
    const claim = backup.search(/supabase\.rpc\(['"]claim_backup_job['"]/);
    const snapshot = backup.search(/['"]prepare_continuity_backup_snapshot['"]/);
    expect(probe).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(probe);
    expect(snapshot).toBeGreaterThan(claim);
    expect(backup).toContain('REPLICA_PREFLIGHT_BLOCKED');
  });

  it('does not expose a readiness response before verifying the receiver token', () => {
    const verification = replica.search(/['"]verify_continuity_replica_token['"]/);
    const check = replica.search(/body\?\.action\s*===\s*['"]preflight['"]/);
    const uuid = replica.indexOf('if (!UUID_RE.test(backupId))');
    expect(verification).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(verification);
    expect(uuid).toBeGreaterThan(check);
    expect(replica).toContain('REPLICA_STORAGE_UNAVAILABLE');
  });
});
