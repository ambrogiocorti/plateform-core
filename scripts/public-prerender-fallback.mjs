import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A preview may show the client-rendered app shell while its backend is offline.
// Production and all non-Vercel builds must still fail closed. Never turn an
// HTTP authorization error or malformed RPC payload into a successful build.
const networkCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function mayUseUnindexedPreviewShell(error, env = process.env) {
  if (env?.VERCEL !== '1' || env?.VERCEL_ENV !== 'preview') return false;
  let cause = error;
  for (let depth = 0; cause && depth < 5; depth++) {
    if (networkCodes.has(cause.code)) return true;
    if (cause instanceof TypeError && cause.message === 'fetch failed') return true;
    cause = cause.cause;
  }
  return false;
}

export async function writeUnindexedPreviewShell(distDir) {
  await writeFile(join(distDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  await rm(join(distDir, 'sitemap.xml'), { force: true });
}
