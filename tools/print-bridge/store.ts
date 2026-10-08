import { DatabaseSync } from 'node:sqlite';
export class BridgeStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`pragma journal_mode=WAL; pragma synchronous=FULL; pragma busy_timeout=5000;
      create table if not exists jobs(id text primary key,device_id text not null,digest text not null,status text not null check(status in ('SENT','SUCCESS','UNKNOWN')),created_at text not null,completed_at text);
      update jobs set status='UNKNOWN',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where status='SENT';`);
  }
  claim(id: string, device: string, digest: string): 'NEW' | 'SENT' | 'SUCCESS' | 'UNKNOWN' {
    const row = this.db.prepare('select device_id,digest,status from jobs where id=?').get(id);
    if (row) {
      if (row.digest !== digest || row.device_id !== device)
        throw new Error('IDEMPOTENCY_MISMATCH');
      return row.status as 'SENT' | 'SUCCESS' | 'UNKNOWN';
    }
    this.db
      .prepare("insert into jobs(id,device_id,digest,status,created_at) values(?,?,?,'SENT',?)")
      .run(id, device, digest, new Date().toISOString());
    return 'NEW';
  }
  finish(id: string, success: boolean): void {
    this.db
      .prepare("update jobs set status=?,completed_at=? where id=? and status='SENT'")
      .run(success ? 'SUCCESS' : 'UNKNOWN', new Date().toISOString(), id);
  }
  close(): void {
    this.db.close();
  }
}
