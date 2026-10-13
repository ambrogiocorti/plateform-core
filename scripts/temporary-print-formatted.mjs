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
  console.log(
    'PLATEFORM_FORMATTED_FILE:' +
      file +
      ':' +
      Buffer.from(formatted, 'utf8').toString('base64'),
  );
}
