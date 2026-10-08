import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIN_NODE = [24, 13, 0];
const problems = [];
const warnings = [];

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.replace(/^v/, ''));
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}
function atLeast(actual, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}
function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}
function bindingPackage() {
  if (process.platform === 'win32' && process.arch === 'x64')
    return '@rolldown/binding-win32-x64-msvc';
  if (process.platform === 'win32' && process.arch === 'arm64')
    return '@rolldown/binding-win32-arm64-msvc';
  if (process.platform === 'darwin' && process.arch === 'x64')
    return '@rolldown/binding-darwin-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64')
    return '@rolldown/binding-darwin-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') {
    const report = process.report?.getReport?.();
    return report?.header?.glibcVersionRuntime
      ? '@rolldown/binding-linux-x64-gnu'
      : '@rolldown/binding-linux-x64-musl';
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    const report = process.report?.getReport?.();
    return report?.header?.glibcVersionRuntime
      ? '@rolldown/binding-linux-arm64-gnu'
      : '@rolldown/binding-linux-arm64-musl';
  }
  return undefined;
}

const actualNode = versionTuple(process.versions.node);
if (!atLeast(actualNode, MIN_NODE))
  problems.push(`Node ${process.versions.node}: richiesto >= ${MIN_NODE.join('.')}.`);

if (!existsSync('package-lock.json')) problems.push('package-lock.json mancante.');
if (!existsSync('node_modules')) problems.push('node_modules mancante: eseguire npm ci.');
const binding = bindingPackage();
if (!binding)
  warnings.push(`Piattaforma non riconosciuta per Rolldown: ${process.platform}/${process.arch}.`);
else if (!existsSync(resolve('node_modules', binding, 'package.json')))
  problems.push(
    `Binding nativo Vite/Rolldown mancante per questa macchina: ${binding}. Rieseguire npm ci.`,
  );

const fileEnv = parseEnvFile('.env.local');
const env = { ...fileEnv, ...process.env };
for (const key of [
  'VITE_PUBLIC_BASE_URL',
  'VITE_STAFF_BASE_URL',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
]) {
  if (!env[key]) problems.push(`${key} non configurata in .env.local o nell'ambiente.`);
}
for (const key of ['VITE_PUBLIC_BASE_URL', 'VITE_STAFF_BASE_URL', 'VITE_SUPABASE_URL']) {
  if (!env[key]) continue;
  try {
    const url = new URL(env[key]);
    if (!['http:', 'https:'].includes(url.protocol)) problems.push(`${key} deve usare http/https.`);
  } catch {
    problems.push(`${key} non contiene un URL valido.`);
  }
}
if (env.VITE_ENVIRONMENT && env.VITE_ENVIRONMENT !== 'development')
  warnings.push(`VITE_ENVIRONMENT=${env.VITE_ENVIRONMENT}: per i test locali usare development.`);

const forbidden = Object.keys(env).filter(
  (key) =>
    key.startsWith('VITE_') &&
    /(SERVICE_ROLE|SECRET_KEY|PRIVATE_KEY|WEBHOOK_SECRET|CALLBACK_TOKEN|WORKER_SECRET)/i.test(key),
);
if (forbidden.length)
  problems.push(`Segreti server esposti con prefisso VITE_: ${forbidden.join(', ')}.`);

const result = {
  ok: problems.length === 0,
  node: process.versions.node,
  platform: `${process.platform}/${process.arch}`,
  rolldown_binding: binding ?? null,
  problems,
  warnings,
};
console.log(JSON.stringify(result, null, 2));
if (problems.length) process.exitCode = 1;
