// Print a bounded, secret-free dependency audit summary during preview builds.
// Advisory findings are actionable evidence but cannot replace manual triage.
import { spawnSync } from 'node:child_process';

const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(cmd, ['audit', '--json', '--audit-level=high'], {
  encoding: 'utf8',
  timeout: 60000,
  maxBuffer: 12 * 1024 * 1024,
  windowsHide: true,
});
if (result.error) throw new Error('DEPENDENCY_AUDIT_EXECUTION_FAILED');
let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch {
  throw new Error('DEPENDENCY_AUDIT_INVALID_RESPONSE');
}
if (
  !parsed?.metadata?.vulnerabilities ||
  !parsed?.vulnerabilities ||
  ![0, 1].includes(result.status)
)
  throw new Error('DEPENDENCY_AUDIT_UNAVAILABLE');
const affected = Object.entries(parsed.vulnerabilities)
  .filter(([, entry]) => ['high', 'critical'].includes(entry.severity))
  .map(([name, entry]) => ({
    package: name,
    severity: entry.severity,
    is_direct: entry.isDirect === true,
    range: String(entry.range ?? '').slice(0, 120),
    fix_available:
      entry.fixAvailable === false
        ? false
        : entry.fixAvailable === true
          ? true
          : {
              name: String(entry.fixAvailable?.name ?? '').slice(0, 100),
              version: String(entry.fixAvailable?.version ?? '').slice(0, 50),
              is_semver_major: entry.fixAvailable?.isSemVerMajor === true,
            },
  }))
  .sort((a, b) => a.package.localeCompare(b.package));
console.log(
  'PLATEFORM_NPM_AUDIT=' +
    JSON.stringify({
      status: affected.length ? 'REMEDIATION_REQUIRED' : 'NO_HIGH_OR_CRITICAL',
      high: Number(parsed.metadata.vulnerabilities.high ?? 0),
      critical: Number(parsed.metadata.vulnerabilities.critical ?? 0),
      affected,
    }),
);
// Production/release candidate preview fails closed on high/critical advisories.
const high = Number(parsed.metadata.vulnerabilities.high ?? 0);
const critical = Number(parsed.metadata.vulnerabilities.critical ?? 0);
if (high > 0 || critical > 0 || affected.length) {
  console.error('DEPENDENCY_AUDIT_HIGH_OR_CRITICAL_BLOCKED');
  process.exitCode = 1;
}
