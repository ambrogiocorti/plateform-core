import { spawnSync } from 'node:child_process';

function inspect(scope, args) {
  const run = spawnSync('npm', ['audit', '--json', ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 90_000,
  });
  if (run.error || (run.status !== 0 && run.status !== 1)) {
    throw new Error(`DEPENDENCY_AUDIT_UNAVAILABLE:${scope}`);
  }
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    throw new Error(`DEPENDENCY_AUDIT_INVALID_RESPONSE:${scope}`);
  }
  if (!report.metadata?.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    throw new Error(`DEPENDENCY_AUDIT_MISSING_FIELDS:${scope}`);
  }
  const vulnerabilities = Object.entries(report.vulnerabilities)
    .map(([name, item]) => ({
      name,
      severity: item.severity,
      isDirect: item.isDirect === true,
      range: item.range,
      fixAvailable: item.fixAvailable === true ? 'compatible' :
        item.fixAvailable === false ? 'none' : 'breaking_or_manual',
      via: (item.via || []).filter((entry) => typeof entry === 'object')
        .map((entry) => ({ title: entry.title, range: entry.range, url: entry.url })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const counts = report.metadata.vulnerabilities;
  console.log(JSON.stringify({ scope, counts, vulnerabilities }, null, 2));
  return { scope, counts, vulnerabilities };
}
const production = inspect('production', ['--omit=dev']);
const all = inspect('complete_lockfile', []);

if ((production.counts.high ?? 0) + (production.counts.critical ?? 0) > 0) {
  console.error('PRODUCTION_DEPENDENCY_SECURITY_GATE=BLOCKED');
  process.exitCode = 1;
} else {
  console.log('PRODUCTION_DEPENDENCY_SECURITY_GATE=PASSED');
}
if ((all.counts.high ?? 0) + (all.counts.critical ?? 0) > 0) {
  console.log('DEVELOPMENT_DEPENDENCY_REMEDIATION_REQUIRED');
}
