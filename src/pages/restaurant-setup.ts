import { z } from 'zod';
import { readPage } from '../api/client';
import { button, el, emptyState, status } from '../components/dom';
import { evaluateSetup, setupDefinitions } from '../services/setup-readiness';
import type { SetupFacts } from '../services/setup-readiness';
import type { StaffContext } from './staff-context';

const identity = z.object({ id: z.uuid() });

/**
 * Read only, tenant-scoped checks using the same PostgREST/RLS path as the
 * configuration screens. Never mark a step complete on network/permission error.
 * Deliberately checks presence, not hypothetical successful service operations.
 */
export async function loadSetupFacts(
  venueId: string,
  canManageSharedCatalog = true,
): Promise<SetupFacts> {
  const rows = await Promise.all(
    setupDefinitions.map(async (step) => {
      const shared = step.key === 'categories' || step.key === 'dishes';
      if (shared && !canManageSharedCatalog)
        return [step.key, 'MANAGED_BY_CHAIN'] as const;
      // Inactive rows do not enable a service, payment post or operational area.
      const filters = { active: 'true' };
      const result = await readPage(step.key, identity, {
        ...(shared ? {} : { venue: venueId }),
        filters,
        limit: 1,
      });
      return [step.key, result.rows.length > 0] as const;
    }),
  );
  return Object.fromEntries(rows) as SetupFacts;
}

export async function restaurantSetupPage(context: StaffContext): Promise<HTMLElement> {
  if (context.profile.role !== 'ADMIN')
    return emptyState('Accesso non autorizzato', 'La preparazione del ristorante è riservata agli Admin.');
  const venue = context.venue;
  if (!venue)
    return emptyState('Nessuna sede', 'Crea o seleziona una sede autorizzata per procedere.');

  const venueId = venue.id;
  const view = el('div', { class: 'stack restaurant-setup' });

  async function refresh(): Promise<void> {
    // If the venue selection changes, do not reuse any previous venue's state.
    if (context.venue?.id !== venueId) return;
    const canManageSharedCatalog = !context.multiVenue || context.profile.scope === 'CHAIN';
    const facts = await loadSetupFacts(venueId, canManageSharedCatalog);
    const progress = evaluateSetup(facts);
    const explanation = progress.basicsConfigured
      ? 'Sono presenti gli elementi minimi di configurazione. Verifica personale, turni, prezzi, disponibilità e l’intero ciclo operativo prima di aprire il servizio.'
      : 'Segui l’ordine indicato. Ogni stato è letto dal database della sede; non vengono creati dati dimostrativi.';

    const header = el(
      'header',
      { class: 'card stack' },
      el('p', { class: 'eyebrow' }, 'AVVIO GUIDATO'),
      el('h2', {}, `Prepara ${venue.name}`),
      el('p', { class: 'muted' }, explanation),
      el(
        'p',
        { role: 'status', 'aria-live': 'polite' },
        `${progress.completed} di ${progress.total} elementi minimi presenti`,
      ),
      button('Ricontrolla configurazione', refresh, 'secondary'),
    );
    if (progress.next)
      header.append(
        el(
          'div',
          { class: 'card stack' },
          el('strong', {}, `Prossimo passo: ${progress.next.title}`),
          el('p', {}, progress.next.description),
          progress.next.requiresChain
            ? el(
                'p',
                { class: 'muted' },
                'Questo catalogo è condiviso tra le sedi: richiedi la configurazione a un Admin di catena.',
              )
            : button('Vai alla configurazione', () => context.navigate(progress.next!.route)),
        ),
      );

    const list = el('ol', { class: 'stack', 'aria-label': 'Preparazione operativa' });
    for (const step of progress.steps)
      list.append(
        el(
          'li',
          { class: 'card row between' },
          el(
            'div',
            { class: 'stack' },
            el('h3', {}, step.title),
            el('p', { class: 'muted' }, step.description),
            status(
              step.requiresChain
                ? 'Richiede Admin di catena'
                : step.completed
                  ? 'Elemento presente'
                  : 'Da configurare',
            ),
          ),
          step.requiresChain
            ? el('span', { class: 'muted' }, 'Gestione della catena')
            : button(
                step.completed ? 'Apri' : 'Configura',
                () => context.navigate(step.route),
                'secondary',
              ),
        ),
      );

    view.replaceChildren(
      header,
      el('section', { class: 'stack' }, el('h2', {}, 'Configurazione della sede'), list),
      el(
        'section',
        { class: 'card stack' },
        el('h2', {}, 'Personale e collaudo del servizio'),
        el(
          'p',
          { class: 'muted' },
          'La presenza degli elementi non assicura ancora che un cameriere, la cucina, il Pass e la cassa possano completare un servizio. Crea gli account necessari, assegna sedi e ruoli, collega piatti e stazioni e verifica i flussi reali.',
        ),
        button('Gestisci staff e assegnazioni', () => context.navigate('/staff'), 'secondary'),
        button('Apri centro operativo', () => context.navigate('/operazioni'), 'secondary'),
      ),
    );
  }

  context.refresh = refresh;
  await refresh();
  return view;
}
