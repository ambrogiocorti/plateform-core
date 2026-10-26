export function validMenuEngineeringPeriod(start: string, end: string): boolean {
  const parseDay = (date: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const millis = Date.parse(`${date}T12:00:00.000Z`);
    return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === date
      ? millis
      : null;
  };
  const from = parseDay(start);
  const to = parseDay(end);
  if (from === null || to === null) return false;
  const days = (to - from) / 86400000;
  return days >= 0 && days <= 366;
}

export function engineeringClassificationLabel(value: string): string {
  const labels: Record<string, string> = {
    STAR: 'Stella · popolare e con buon margine',
    PLOWHORSE: 'Cavallo di battaglia · popolare, margine più basso',
    PUZZLE: 'Da valorizzare · margine alto, poco popolare',
    DOG: 'Da valutare · popolarità e margine bassi',
    INCOMPLETE_COST: 'Food cost incompleto',
    NO_COST: 'Food cost non disponibile',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
}
