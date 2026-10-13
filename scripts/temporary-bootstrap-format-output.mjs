import { readFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';

for (const path of [
  'scripts/bootstrap-local.mjs',
  'docs/LOCAL_BOOTSTRAP_NO_GITHUB_RUNNER.md',
]) {
  const original = await readFile(path, 'utf8');
  const result = await format(original, {
    ...(await resolveConfig(path)),
    filepath: path,
  });
  const chunks = Buffer.from(result, 'utf8').toString('base64');
  for (let offset = 0; offset < chunks.length; offset += 800) {
    console.log(
      'PLATEFORM_LOCAL_BOOTSTRAP_FORMAT:' +
        path +
        ':' +
        String(offset / 800) +
        ':' +
        chunks.slice(offset, offset + 800),
    );
  }
}
