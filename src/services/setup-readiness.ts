/** A minimum operational configuration, not a release or service-acceptance certificate. */
export const setupDefinitions = [
  {
    key: 'rooms',
    title: 'Sale',
    description: 'Crea almeno una sala attiva per la sede.',
    route: '/gestione?modulo=rooms',
  },
  {
    key: 'room_layouts',
    title: 'Layout attivo',
    description: 'Crea un layout e attivalo nell’Editor sala prima di aprire i tavoli.',
    route: '/gestione?modulo=room_layouts',
  },
  {
    key: 'tables',
    title: 'Tavoli',
    description: 'Configura almeno un tavolo attivo assegnato alla sede.',
    route: '/gestione?modulo=tables',
  },
  {
    key: 'services',
    title: 'Servizi',
    description: 'Imposta almeno un servizio, ad esempio pranzo o cena, con i relativi orari.',
    route: '/gestione?modulo=services',
  },
  {
    key: 'stations',
    title: 'Stazioni di preparazione',
    description: 'Crea almeno una stazione attiva per instradare le comande in cucina.',
    route: '/gestione?modulo=stations',
  },
  {
    key: 'categories',
    title: 'Categorie del menu',
    description: 'Organizza i piatti in almeno una categoria attiva.',
    route: '/gestione?modulo=categories',
  },
  {
    key: 'dishes',
    title: 'Piatti e bevande',
    description:
      'Inserisci almeno un prodotto attivo; verifica anche composizione e disponibilità.',
    route: '/gestione?modulo=dishes',
  },
  {
    key: 'cash_registers',
    title: 'Postazione cassa',
    description: 'Configura almeno una postazione per i pagamenti e le quadrature.',
    route: '/gestione?modulo=cash_registers',
  },
] as const;

export type SetupKey = (typeof setupDefinitions)[number]['key'];
export type SetupFact = boolean | 'MANAGED_BY_CHAIN';
export type SetupFacts = Readonly<Record<SetupKey, SetupFact>>;

export function evaluateSetup(facts: SetupFacts) {
  const steps = setupDefinitions.map((definition) => ({
    ...definition,
    completed: facts[definition.key] === true,
    requiresChain: facts[definition.key] === 'MANAGED_BY_CHAIN',
  }));
  const completed = steps.filter((step) => step.completed).length;
  return {
    steps,
    completed,
    total: steps.length,
    next: steps.find((step) => !step.completed) ?? null,
    basicsConfigured: completed === steps.length,
  };
}
