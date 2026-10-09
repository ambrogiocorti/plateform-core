import { createHash } from 'node:crypto';

export const masterSectionCount = 158;
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function masterSections(text) {
  const matches = [...text.matchAll(/^#{1,2} (\d+)\. ([^\r\n]+)$/gm)];
  const sections = matches.map((match, i) => {
    const source = text.slice(match.index, matches[i + 1]?.index ?? text.length);
    return { section: Number(match[1]), title: match[2], source, source_sha256: sha256(source) };
  });
  if (sections.length !== masterSectionCount || sections.some((row, i) => row.section !== i))
    throw new Error('MASTER_SECTION_INVENTORY_MISMATCH');
  return sections;
}

export function specificationProblems(matrix, text) {
  const sections = masterSections(text);
  if (
    matrix.specification !== 'MASTER_PROMPT_PLATEFORM_COMMERCIALE.md' ||
    matrix.specification_sha256 !== sha256(text) ||
    matrix.sections?.length !== masterSectionCount ||
    sections.some((row, i) => {
      const entry = matrix.sections[i];
      return (
        entry?.section !== row.section ||
        entry?.title !== row.title ||
        entry?.source_sha256 !== row.source_sha256
      );
    })
  )
    return [
      'La matrice requisiti deve corrispondere integralmente al Master aggiornato (§§0–157).',
    ];
  return [];
}
