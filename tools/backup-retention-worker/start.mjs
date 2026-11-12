import { loadConfig, checkPrerequisites } from './config.mjs';
import { claimRetention, finishRetention } from './protocol.mjs';
import { purgeBackupCopies } from './filesystem.mjs';

function safeError(error) {
  const raw = error instanceof Error ? error.message : 'RETENTION_WORKER_FAILED';
  const code = raw.split(':')[0].replace(/[^A-Z0-9_]/g, '_');
  return code.length >= 2 && code.length <= 80 ? code : 'RETENTION_WORKER_FAILED';
}

async function processJob(config, job) {
  const id = String(job.id);
  const leaseToken = String(job.lease_token);
  try {
    const purged = await purgeBackupCopies(
      config.backupRoot,
      config.replicaRoot,
      id,
      job.database_reference,
    );
    await finishRetention(config, { id, leaseToken, success: true });
    return {
      id,
      status: 'PURGED',
      primaryAlreadyMissing: purged.primary.alreadyMissing,
      replicaAlreadyMissing: purged.replica.alreadyMissing,
    };
  } catch (error) {
    const errorCode = safeError(error);
    await finishRetention(config, { id, leaseToken, success: false, errorCode }).catch(
      (finishError) => {
        throw new AggregateError(
          [error, finishError],
          `RETENTION_FAILURE_NOT_RECORDED:${errorCode}`,
        );
      },
    );
    throw error;
  }
}

const mode = process.argv[2] ?? '--check';
const config = loadConfig();
const prerequisite = await checkPrerequisites(config);
if (mode === '--check') {
  console.log(JSON.stringify({ status: 'READY', ...prerequisite }));
  process.exit(0);
}
if (mode !== '--once') throw new Error('USAGE: backup-retention-worker --check|--once');
const job = await claimRetention(config);
if (!job) {
  console.log(JSON.stringify({ status: 'IDLE' }));
  process.exit(0);
}
console.log(JSON.stringify(await processJob(config, job)));
