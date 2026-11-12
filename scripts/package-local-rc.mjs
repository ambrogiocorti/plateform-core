import { spawnSync } from 'node:child_process';

const candidates =
  process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python', 'py'];
let lastError;
for (const command of candidates) {
  const args =
    command === 'py'
      ? ['-3', 'scripts/local-release-archive.py']
      : ['scripts/local-release-archive.py'];
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error?.code === 'ENOENT') {
    lastError = result.error;
    continue;
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.exit(0);
}
throw new Error('Python 3 non trovato: installare Python oppure usare lo ZIP RC già generato.', {
  cause: lastError,
});
