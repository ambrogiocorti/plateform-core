import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const masterSectionCount = 158;
const specification = readFileSync(
  new URL('../MASTER_PROMPT_PLATEFORM_COMMERCIALE.md', import.meta.url),
);
const sections = [...specification.toString('utf8').matchAll(/^#{1,6} (\d+)\. .+$/gm)].map(
  (entry) => Number(entry[1]),
);
if (sections.length !== masterSectionCount || sections.some((section, i) => section !== i))
  throw new Error('Il Master Prompt canonico deve contenere tutte le sezioni 0–157, in ordine.');
export const masterSpecificationDigest = createHash('sha256').update(specification).digest('hex');
