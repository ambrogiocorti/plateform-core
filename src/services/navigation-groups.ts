export const navigationSections = [
  {
    id: 'service',
    label: 'Servizio',
    icon: '/sala',
    paths: ['/servizio', '/sala', '/accoglienza', '/cucina', '/pass', '/consegne'],
  },
  {
    id: 'accounts',
    label: 'Conti e cassa',
    icon: '/conti',
    paths: ['/conti', '/cassa', '/statistiche'],
  },
  {
    id: 'activity',
    label: 'Attività',
    icon: '/notifiche',
    paths: ['/eccezioni', '/modifiche', '/conflitti', '/stampe', '/notifiche'],
  },
  {
    id: 'restaurant',
    label: 'Ristorante',
    icon: '/menu-sede',
    paths: ['/menu-sede', '/food-cost', '/editor', '/pianificazione', '/sito', '/preparazione'],
  },
  {
    id: 'administration',
    label: 'Amministrazione',
    icon: '/gestione',
    paths: ['/gestione', '/impostazioni', '/staff', '/dispositivi', '/privacy', '/sedi', '/audit'],
  },
] as const;

export function groupedNavigation<T extends { path: string }>(permitted: T[], landing?: string) {
  const remaining = permitted.filter((entry) => entry.path !== landing);
  const groups = navigationSections
    .map((section) => ({
      ...section,
      entries: section.paths.flatMap((path) => remaining.filter((entry) => entry.path === path)),
    }))
    .filter((section) => section.entries.length);
  const assigned = new Set(groups.flatMap((section) => section.entries));
  const other = remaining.filter((entry) => !assigned.has(entry));
  return { groups, other };
}
