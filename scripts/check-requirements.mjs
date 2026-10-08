import { readFile } from 'node:fs/promises';
const document = JSON.parse(await readFile('docs/REQUIREMENTS.json', 'utf8'));
const sections = document.sections;
const seen = new Set(sections.map((entry) => entry.section));
if (seen.size !== 151 || Array.from({ length: 151 }, (_, i) => i).some((i) => !seen.has(i))) {
  throw new Error('La matrice deve contenere tutte le sezioni 0–150.');
}
const incomplete = sections.filter((entry) => entry.status !== 'verified');
console.log(`${sections.length - incomplete.length}/151 sezioni verificate.`);
for (const entry of incomplete) console.log(`§${entry.section} ${entry.status}: ${entry.title}`);
if (incomplete.length) process.exitCode = 1;
