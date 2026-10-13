import { readFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';

for (const file of [
  'scripts/plan-migration-promotion.mjs',
  'docs/MIGRATION_PROMOTION_PREFLIGHT_2026-10-13.md',
]) {
  const source = await readFile(file, 'utf8');
  const formatted = await format(source, {
    ...(await resolveConfig(file)),
    filepath: file,
  });
  const encoded = Buffer.from(formatted, 'utf8').toString('base64');
  for (let i = 0; i < encoded.length; i += 800) {
    console.log('PLATEFORM_FORMATTED_CHUNK:' + file + ':' + i / 800 + ':' + encoded.slice(i, i + 800));
  }
}
