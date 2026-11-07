/** Keep internal app links inside their deployed base, including query strings. */
export function appLink(value: string, base: string, area: string): string {
  if (
    !['public', 'staff'].includes(area) ||
    base === '/' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value === base.replace(/\/$/, '') ||
    value.startsWith(base)
  )
    return value;
  return `${base.replace(/\/$/, '')}${value}`;
}
