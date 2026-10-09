export const masterSectionCount: number;
export function sha256(text: string): string;
export function masterSections(text: string): {
  section: number;
  title: string;
  source: string;
  source_sha256: string;
}[];
export function specificationProblems(
  matrix: {
    specification: string;
    specification_sha256: string;
    sections: { section: number; title: string; source_sha256: string }[];
  },
  text: string,
): string[];
