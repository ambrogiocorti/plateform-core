import { checkRelease } from './check-release.mjs';
import { spawnSync } from 'node:child_process';
const { evidence } = await checkRelease();
const result = spawnSync('python3', ['scripts/release-archive.py', evidence.version], {
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
