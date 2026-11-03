import { readFile } from 'node:fs/promises';
import { masterSectionCount, masterSpecificationDigest } from './master-requirements.mjs';
const document = JSON.parse(await readFile('docs/REQUIREMENTS.json', 'utf8'));
const sections = document.sections;
const seen = new Set(sections.map((entry) => entry.section));
if (
  sections.length !== masterSectionCount ||
  seen.size !== masterSectionCount ||
  Array.from({ length: masterSectionCount }, (_, i) => i).some((i) => !seen.has(i))
) {
  throw new Error('La matrice deve contenere tutte le sezioni 0–157.');
}
if (document.specification_sha256 !== masterSpecificationDigest)
  throw new Error('La matrice non corrisponde al Master Prompt canonico.');
const incomplete = sections.filter((entry) => entry.status !== 'verified');
console.log(`${sections.length - incomplete.length}/${masterSectionCount} sezioni verificate.`);
for (const entry of incomplete) console.log(`§${entry.section} ${entry.status}: ${entry.title}`);
if (incomplete.length) process.exitCode = 1;
