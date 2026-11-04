import { registerPwa } from '../../src/services/pwa';
import '../../styles/staff.css';
import '../../styles/staff-app.css';
import '../../styles/workspace-redesign.css';
import '../../styles/frontdesk-v4.css';
import '../../styles/workspace-v5.css';
import {
  el,
  button,
  dialog,
  field,
  emptyState,
  loading,
  showError,
} from '../../src/components/dom';
import { environment } from '../../src/config/environment';
import { activeProfile, loginPage, signOut, requirements } from '../../src/auth/staff';
import {
  consumePasswordRecoveryIntent,
  passwordRecoveryPage,
} from '../../src/auth/password-recovery';
import { openAccessSecurity } from '../../src/auth/access-security';
import { stepUp } from '../../src/auth/step-up';
import { rpc } from '../../src/api/client';
import { z } from 'zod';
import { client } from '../../src/api/client';
import { lockedPage, lockSession, editPin } from '../../src/auth/lock';
import { watchLive } from '../../src/realtime/live';
import type { ConnectionState } from '../../src/realtime/live';
import { loadContext } from '../../src/pages/staff-context';
import type { StaffContext } from '../../src/pages/staff-context';
import type { UserRole } from '../../src/types/domain';
import {
  clearNotificationIndicator,
  notificationIndicator,
  refreshNotificationIndicator,
} from '../../src/components/notification-indicator';

const root = document.getElementById('app');
if (!root) throw new Error('Missing application root');
const app: HTMLElement = root;
let renderRevision = 0;
let recoveryIntent = consumePasswordRecoveryIntent();
let currentContext: StaffContext | null = null;
let authExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let liveKey = '';
let stopLive: (() => void) | undefined;
let connectionState: ConnectionState = 'CONNECTING';
function connectionLabel(): string {
  return {
    CONNECTING: 'Connessione in corso',
    LIVE: 'Aggiornamenti connessi',
    DEGRADED: 'Aggiornamenti da verificare',
    OFFLINE: 'MODALITÀ OFFLINE',
  }[connectionState];
}
function disconnectLive(): void {
  stopLive?.();
  stopLive = undefined;
  liveKey = '';
}
async function refreshVisiblePage(): Promise<void> {
  if (!currentContext) return;
  void rpc('heartbeat_device', {}, z.boolean()).catch(() => undefined);
  await refreshNotificationIndicator();
  if (
    document.querySelector('dialog[open]') ||
    document.activeElement?.matches('input,select,textarea,[contenteditable]')
  ) {
    const notice = document.getElementById('live-refresh');
    if (notice) notice.hidden = false;
    return;
  }
  await currentContext.refresh?.();
}
function navIcon(path: string): SVGSVGElement {
  // Navigation icon paths are local and role-independent; permissions remain server enforced.
  const icons: Record<string, string> = {
    '/operazioni': 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    '/sala': 'M4 12h16 M7 12V6h10v6 M7 12v6 M17 12v6 M5 18h14',
    '/conti': 'M5 3h14v18l-3-2-3 2-3-2-3 2-2-2z M8 8h8 M8 12h8 M8 16h5',
    '/cassa': 'M3 7h18v12H3z M3 11h18 M16 15h2',
    '/statistiche': 'M4 20V10 M10 20V4 M16 20v-7 M22 20V8',
    '/accoglienza': 'M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M4 21a8 8 0 0 1 16 0',
    '/servizio': 'M5 4h14 M12 4v16 M5 13h14 M7 20h10',
    '/gestione':
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2v3 M12 19v3 M4 4l2 2 M18 18l2 2 M2 12h3 M19 12h3 M4 20l2-2 M18 6l2-2',
    '/sito': 'M3 5h18v14H3z M3 9h18 M8 9v10',
    '/menu-sede': 'M4 4h16v16H4z M8 9h8 M8 13h8 M8 17h6',
    '/stampe': 'M6 9V3h12v6 M6 18H4V9h16v9h-2 M6 15h12v6H6z',
    '/dispositivi': 'M6 3h12v18H6z M10 17h4',
    '/pianificazione': 'M3 5h18v16H3z M3 10h18 M7 3v4 M17 3v4',
    '/salute': 'M3 12h4l3-6 4 12 3-6h4',
  };
  const data =
    icons[path] ??
    (path.startsWith('/cucina') ? 'M5 4h14v16H5z M8 9h8 M8 13h8' : 'M4 4h16v16H4z M9 9h6v6H9z');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', data);
  svg.append(shape);
  return svg;
}

const navigation: {
  path: string;
  label: string;
  roles: UserRole[];
  section?: 'OPERATIVITÀ' | 'CONFIGURAZIONE';
}[] = [
  { path: '/operazioni', label: 'Operazioni', roles: ['ADMIN'], section: 'OPERATIVITÀ' },
  { path: '/eccezioni', label: 'Eccezioni servizio', roles: ['ADMIN'], section: 'OPERATIVITÀ' },
  { path: '/preparazione', label: 'Avvio guidato', roles: ['ADMIN'], section: 'CONFIGURAZIONE' },
  { path: '/menu-sede', label: 'Menu della sede', roles: ['ADMIN'], section: 'CONFIGURAZIONE' },
  { path: '/food-cost', label: 'Food cost e margini', roles: ['ADMIN'], section: 'CONFIGURAZIONE' },
  { path: '/servizio', label: 'Servizio', roles: ['WAITER'] },
  { path: '/salute', label: 'Operational Health', roles: ['SUPER_ADMIN'] },
  { path: '/sedi', label: 'Sedi', roles: ['SUPER_ADMIN'], section: 'CONFIGURAZIONE' },
  { path: '/accoglienza', label: 'Accoglienza', roles: ['ADMIN', 'HOST'], section: 'OPERATIVITÀ' },
  {
    path: '/sala',
    label: 'Sala',
    roles: ['ADMIN', 'HOST', 'WAITER', 'CASHIER', 'PASS'],
    section: 'OPERATIVITÀ',
  },
  { path: '/conti', label: 'Conti', roles: ['ADMIN', 'WAITER', 'CASHIER'], section: 'OPERATIVITÀ' },
  { path: '/cassa', label: 'Cassa', roles: ['ADMIN', 'CASHIER'], section: 'OPERATIVITÀ' },
  {
    path: '/statistiche',
    label: 'Statistiche',
    roles: ['ADMIN', 'CASHIER'],
    section: 'OPERATIVITÀ',
  },
  { path: '/conflitti', label: 'Conflitti offline', roles: ['ADMIN'], section: 'OPERATIVITÀ' },
  {
    path: '/dispositivi',
    label: 'Dispositivi',
    roles: ['ADMIN', 'SUPER_ADMIN'],
    section: 'CONFIGURAZIONE',
  },
  {
    path: '/stampe',
    label: 'Stampe',
    roles: ['ADMIN', 'CASHIER', 'WAITER', 'KITCHEN_ADMIN', 'KITCHEN_STAFF', 'PASS'],
    section: 'OPERATIVITÀ',
  },
  { path: '/modifiche', label: 'Approvazioni comande', roles: ['ADMIN'], section: 'OPERATIVITÀ' },
  { path: '/editor', label: 'Editor sala', roles: ['ADMIN'], section: 'CONFIGURAZIONE' },
  {
    path: '/pianificazione',
    label: 'Turni e prenotazioni',
    roles: ['ADMIN'],
    section: 'CONFIGURAZIONE',
  },
  { path: '/gestione', label: 'Configurazione', roles: ['ADMIN'], section: 'CONFIGURAZIONE' },
  { path: '/sito', label: 'Sito e branding', roles: ['ADMIN'], section: 'CONFIGURAZIONE' },
  {
    path: '/impostazioni',
    label: 'Regole del servizio',
    roles: ['ADMIN'],
    section: 'CONFIGURAZIONE',
  },
  { path: '/privacy', label: 'Dati personali', roles: ['ADMIN'], section: 'CONFIGURAZIONE' },
  { path: '/audit', label: 'Audit', roles: ['SUPER_ADMIN'] },
  { path: '/staff', label: 'Staff', roles: ['ADMIN', 'SUPER_ADMIN'], section: 'CONFIGURAZIONE' },
  {
    path: '/cucina',
    label: 'Cucina',
    roles: ['ADMIN', 'KITCHEN_ADMIN', 'KITCHEN_STAFF'],
    section: 'OPERATIVITÀ',
  },
  { path: '/pass', label: 'Pass', roles: ['PASS'] },
  { path: '/consegne', label: 'Consegne', roles: ['WAITER'] },
  {
    path: '/notifiche',
    label: 'Notifiche',
    roles: ['ADMIN', 'HOST', 'WAITER', 'CASHIER', 'KITCHEN_ADMIN', 'KITCHEN_STAFF', 'PASS'],
    section: 'OPERATIVITÀ',
  },
];

type NavigationEntry = (typeof navigation)[number];

const primaryDestinations: Partial<Record<UserRole, string[]>> = {
  ADMIN: ['/operazioni', '/sala', '/accoglienza', '/cucina', '/conti', '/cassa'],
  HOST: ['/accoglienza', '/sala', '/notifiche'],
  WAITER: ['/servizio', '/sala', '/conti', '/consegne', '/notifiche'],
  CASHIER: ['/cassa', '/conti', '/sala', '/statistiche', '/stampe'],
  KITCHEN_ADMIN: ['/cucina', '/stampe', '/notifiche'],
  KITCHEN_STAFF: ['/cucina', '/stampe', '/notifiche'],
  PASS: ['/pass', '/sala', '/stampe', '/notifiche'],
  SUPER_ADMIN: ['/salute', '/sedi', '/staff', '/dispositivi', '/audit'],
};

function primaryNavigation(role: UserRole, permitted: NavigationEntry[]): NavigationEntry[] {
  const order = primaryDestinations[role] ?? [];
  const ordered = order
    .map((path) => permitted.find((entry) => entry.path === path))
    .filter((entry): entry is NavigationEntry => Boolean(entry));
  return ordered.length ? ordered : permitted.slice(0, 5);
}

function moreNavigationGroup(path: string): string {
  if (
    [
      '/operazioni',
      '/sala',
      '/accoglienza',
      '/cucina',
      '/conti',
      '/cassa',
      '/statistiche',
    ].includes(path)
  )
    return 'Servizio e controllo';
  if (
    ['/eccezioni', '/conflitti', '/modifiche', '/stampe', '/notifiche', '/consegne'].includes(path)
  )
    return 'Flussi e attività';
  if (
    ['/menu-sede', '/food-cost', '/editor', '/pianificazione', '/sito', '/preparazione'].includes(
      path,
    )
  )
    return 'Ristorante e contenuti';
  if (
    [
      '/gestione',
      '/impostazioni',
      '/privacy',
      '/staff',
      '/dispositivi',
      '/sedi',
      '/audit',
    ].includes(path)
  )
    return 'Amministrazione e sicurezza';
  return 'Altre aree';
}

function pageDescription(path: string): string {
  const descriptions: Record<string, string> = {
    '/operazioni': 'Tutto ciò che serve per coordinare il servizio, in un unico spazio.',
    '/sala': 'Tavoli, disponibilità e stato del servizio.',
    '/accoglienza': 'Prenotazioni, arrivi e gestione degli ospiti.',
    '/cucina': 'Comande in lavorazione, tempi e priorità.',
    '/conti': 'Conti aperti, dettagli e operazioni autorizzate.',
    '/cassa': 'Pagamenti, incassi e chiusure di cassa.',
    '/salute': 'Stato operativo della piattaforma e delle installazioni.',
  };
  return descriptions[path] ?? 'Strumenti e informazioni per la tua attività.';
}

const staffBase = import.meta.env.BASE_URL;
const staffHref = (path: string) => staffBase + path.replace(/^\//, '');
const staffPath = () => location.pathname.slice(staffBase.length - 1) || '/';
const recoveredRoute = sessionStorage.getItem('plateform-route-staff');
if (recoveredRoute && recoveredRoute.startsWith(staffBase)) {
  sessionStorage.removeItem('plateform-route-staff');
  history.replaceState(null, '', recoveredRoute);
}
function navigate(path: string): void {
  history.pushState(null, '', staffHref(path));
  void render().catch(showError);
}

async function render(): Promise<void> {
  const revision = ++renderRevision;
  currentContext = null;
  clearNotificationIndicator();
  clearTimeout(authExpiryTimer);
  for (const modal of document.querySelectorAll('dialog')) modal.close();
  try {
    environment();
  } catch {
    app.replaceChildren(
      el(
        'main',
        { id: 'main', class: 'workspace' },
        el('p', { class: 'brand' }, 'Plateform'),
        emptyState(
          'Configurazione richiesta',
          'Configura le variabili di ambiente e il progetto Supabase per accedere al gestionale.',
        ),
      ),
    );
    return;
  }
  if (!navigator.onLine) {
    disconnectLive();
    app.replaceChildren(await (await import('../../src/pages/offline')).offlinePage());
    return;
  }
  if (recoveryIntent) {
    disconnectLive();
    const page = await passwordRecoveryPage(recoveryIntent, () => {
      recoveryIntent = null;
      navigate('/login');
    });
    if (revision === renderRevision) app.replaceChildren(page);
    return;
  }
  const {
    data: { session },
  } = await client().auth.getSession();
  const authInfo = session ? await requirements() : null;
  if (revision !== renderRevision) return;
  if (authInfo && !authInfo.session_unlocked) {
    disconnectLive();
    app.replaceChildren(lockedPage(authInfo, render));
    return;
  }
  const profile = session ? await activeProfile() : null;
  if (revision !== renderRevision) return;
  if (!profile) {
    disconnectLive();
    if (staffPath() !== '/login') history.replaceState(null, '', staffHref('/login'));
    app.replaceChildren(
      loginPage(async () => {
        navigate('/');
      }),
    );
    return;
  }
  const context = await loadContext(profile, navigate);
  if (revision !== renderRevision) return;
  currentContext = context;
  context.refresh = async () => {
    const position = window.scrollY;
    await render();
    window.scrollTo(0, position);
  };
  if (revision !== renderRevision) return;
  if (authInfo?.full_auth_expires_at)
    authExpiryTimer = setTimeout(
      () => {
        void render().catch(showError);
      },
      Math.max(0, Date.parse(authInfo.full_auth_expires_at) - Date.now()) + 1000,
    );
  const links = navigation.filter(
    (entry) =>
      entry.roles.includes(profile.role) &&
      (entry.path !== '/food-cost' || context.licensedFeatures?.has('FOOD_COST')),
  );
  const roleLanding: Partial<Record<UserRole, string>> = {
    CASHIER: '/cassa',
    KITCHEN_ADMIN: '/cucina',
    KITCHEN_STAFF: '/cucina',
    PASS: '/pass',
  };
  const firstAllowedPath = roleLanding[profile.role] ?? links[0]?.path;
  if (staffPath() === '/' || staffPath() === '/login')
    history.replaceState(null, '', staffHref(firstAllowedPath ?? '/operazioni'));
  const pageLink = links.find(
    (entry) => staffPath() === entry.path || staffPath().startsWith(`${entry.path}/`),
  );
  const mainLinks = primaryNavigation(profile.role, links);
  const extraLinks = links.filter((link) => !mainLinks.includes(link));
  const directoryLinks = [...mainLinks.slice(4), ...extraLinks];
  const today = new Date().toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const main = el(
    'main',
    { id: 'main', class: 'workspace' },
    el(
      'header',
      { class: 'page-heading workspace-page-heading' },
      el(
        'div',
        { class: 'workspace-title-group' },
        el(
          'nav',
          { class: 'workspace-breadcrumb', 'aria-label': 'Percorso corrente' },
          el('span', {}, context.venue?.name ?? 'Plateform'),
          el('span', { 'aria-hidden': 'true' }, '›'),
          el('strong', {}, pageLink?.label ?? 'Panoramica'),
        ),
        el('h1', {}, pageLink?.label ?? 'Panoramica'),
        el('p', { class: 'workspace-subtitle' }, pageDescription(pageLink?.path ?? '/operazioni')),
      ),
      el(
        'div',
        { class: 'workspace-heading-actions' },
        el('span', { class: 'workspace-date', 'aria-label': 'Data corrente' }, today),
        button(
          'Aggiorna',
          () => {
            void context.refresh?.();
          },
          'secondary',
        ),
      ),
    ),
    loading(),
  );
  const heading = main.firstChild;
  const venueControl =
    context.multiVenue && context.venues.length > 1
      ? el(
          'select',
          { 'aria-label': 'Sede operativa' },
          ...context.venues.map((venue) => el('option', { value: venue.id }, venue.name)),
        )
      : null;
  if (venueControl) {
    venueControl.value = context.venue?.id ?? '';
    venueControl.addEventListener('change', () => {
      void rpc(
        'set_operational_venue',
        { p_venue: venueControl.value },
        z.object({ current_venue_id: z.uuid() }),
      )
        .then(() => navigate('/'))
        .catch(showError);
    });
  }
  const collapsedSidebar = localStorage.getItem('plateform-sidebar') !== 'expanded';
  const sidebarToggle = el(
    'button',
    {
      type: 'button',
      class: 'sidebar-toggle',
      'aria-label': collapsedSidebar ? 'Espandi il menu laterale' : 'Comprimi il menu laterale',
      'aria-expanded': String(!collapsedSidebar),
      title: collapsedSidebar ? 'Espandi menu' : 'Comprimi menu',
    },
    el('span', { 'aria-hidden': 'true' }, '⇥'),
  );
  const moreDialog: HTMLDialogElement = el(
    'dialog',
    { class: 'workspace-directory', 'aria-label': 'Tutte le funzioni disponibili' },
    el(
      'div',
      { class: 'directory-header' },
      el(
        'div',
        {},
        el('span', { class: 'directory-kicker' }, 'ESPLORA PLATEFORM'),
        el('h2', {}, 'Tutte le funzioni'),
        el('p', {}, 'Le aree disponibili per il tuo ruolo.'),
      ),
      button('Chiudi', () => moreDialog.close(), 'quiet'),
    ),
    el(
      'div',
      { class: 'directory-groups' },
      ...[
        'Servizio e controllo',
        'Flussi e attività',
        'Ristorante e contenuti',
        'Amministrazione e sicurezza',
        'Altre aree',
      ]
        .map((group) => ({
          group,
          items: directoryLinks.filter((entry) => moreNavigationGroup(entry.path) === group),
        }))
        .filter(({ items }) => items.length > 0)
        .map(({ group, items }) =>
          el(
            'section',
            { class: 'directory-section' },
            el('h3', {}, group),
            ...items.map((entry) =>
              el(
                'a',
                {
                  href: staffHref(entry.path),
                  class: 'directory-link',
                  ...(pageLink?.path === entry.path ? { 'aria-current': 'page' } : {}),
                },
                el(
                  'span',
                  { class: 'directory-link-icon', 'aria-hidden': 'true' },
                  navIcon(entry.path),
                ),
                el('span', {}, entry.label),
                el('span', { class: 'directory-link-arrow', 'aria-hidden': 'true' }, '↗'),
              ),
            ),
          ),
        ),
    ),
  );
  const moreButton = el(
    'button',
    {
      type: 'button',
      class: 'nav-link nav-more',
      'aria-label': 'Apri tutte le funzioni',
      'aria-haspopup': 'dialog',
      title: 'Tutte le funzioni',
      ...(extraLinks.some((link) => link.path === pageLink?.path)
        ? { 'data-current': 'true' }
        : {}),
    },
    el('span', { class: 'nav-icon', 'aria-hidden': 'true' }, '⋯'),
    el('span', { class: 'nav-label' }, 'Tutte'),
  );
  moreButton.addEventListener('click', () => moreDialog.showModal());
  const searchControl = button('Cerca  ⌘K', () => openPalette(), 'quiet');
  searchControl.classList.add('topbar-search');
  searchControl.setAttribute('aria-label', 'Cerca funzioni, tavoli, conti e prenotazioni');
  const themeIsDark = document.documentElement.dataset.theme === 'dark';
  const themeControl = button(
    themeIsDark ? '☀' : '☾',
    () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('plateform-theme', next);
      void render();
    },
    'quiet',
  );
  themeControl.classList.add('topbar-theme');
  themeControl.setAttribute('aria-label', themeIsDark ? 'Attiva tema chiaro' : 'Attiva tema scuro');
  themeControl.title = themeIsDark ? 'Attiva tema chiaro' : 'Attiva tema scuro';
  const lockControl = button(
    'Blocca',
    async () => {
      await lockSession();
      await render();
    },
    'quiet',
  );
  lockControl.classList.add('topbar-lock');
  const profileControl = button(profile.display_name, openProfile, 'quiet');
  profileControl.classList.add('topbar-profile');
  profileControl.setAttribute('aria-label', 'Apri profilo di ' + profile.display_name);
  const shell = el(
    'div',
    {
      class: collapsedSidebar ? 'staff-shell sidebar-collapsed' : 'staff-shell',
      'data-role': profile.role,
    },
    el(
      'aside',
      { class: 'sidebar' },
      el(
        'div',
        { class: 'sidebar-brand-row' },
        el(
          'a',
          { class: 'brand', href: staffHref('/') },
          el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'P'),
          el('span', { class: 'brand-wordmark' }, 'Plateform'),
        ),
        sidebarToggle,
      ),
      el(
        'nav',
        { class: 'primary-navigation', 'aria-label': 'Aree principali' },
        ...mainLinks.map((link) =>
          el(
            'a',
            {
              href: staffHref(link.path),
              class: 'nav-link',
              title: link.label,
              'aria-label': link.label,
              ...(pageLink?.path === link.path ? { 'aria-current': 'page' } : {}),
            },
            el('span', { class: 'nav-icon', 'aria-hidden': 'true' }, navIcon(link.path)),
            el('span', { class: 'nav-label' }, link.label),
          ),
        ),
        ...(directoryLinks.length ? [moreButton] : []),
      ),
      el(
        'footer',
        { class: 'sidebar-footer' },
        el('span', { class: 'sidebar-footer-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'sidebar-footer-copy' }, `Release ${environment().releaseVersion}`),
      ),
    ),
    el(
      'div',
      {},
      el(
        'header',
        { class: 'topbar' },
        el(
          'div',
          { class: 'topbar-location' },
          el(
            'span',
            { class: 'topbar-location-symbol', 'aria-hidden': 'true' },
            (context.venue?.name ?? 'P').slice(0, 1).toUpperCase(),
          ),
          el(
            'div',
            {},
            el('span', { class: 'topbar-location-caption' }, 'SEDE ATTIVA'),
            el('strong', { class: 'context' }, context.venue?.name ?? 'Configurazione iniziale'),
          ),
        ),
        import.meta.env.VITE_PAGES_MODE === 'test'
          ? el('span', { class: 'design-preview-stamp' }, 'NUOVA UI · TEST')
          : null,
        el('span', { id: 'connection-state', class: 'muted', role: 'status' }, connectionLabel()),
        venueControl,
        el(
          'div',
          { class: 'row topbar-actions' },
          ['ADMIN', 'SUPER_ADMIN', 'HOST', 'CASHIER'].includes(profile.role) ? searchControl : null,
          profile.role === 'SUPER_ADMIN' ? null : notificationIndicator(context),
          themeControl,
          lockControl,
          profileControl,
        ),
      ),
      main,
    ),
  );
  sidebarToggle.addEventListener('click', () => {
    const compact = shell.classList.toggle('sidebar-collapsed');
    sidebarToggle.setAttribute('aria-expanded', String(!compact));
    sidebarToggle.setAttribute(
      'aria-label',
      compact ? 'Espandi il menu laterale' : 'Comprimi il menu laterale',
    );
    sidebarToggle.title = compact ? 'Espandi menu' : 'Comprimi menu';
    localStorage.setItem('plateform-sidebar', compact ? 'collapsed' : 'expanded');
  });
  moreDialog.addEventListener('click', (event) => {
    if (event.target === moreDialog) moreDialog.close();
  });
  shell.append(moreDialog);
  const assistance = sessionStorage.getItem('plateform-impersonation');
  if (assistance) {
    const info = await rpc(
      'get_impersonation_context',
      { p_id: assistance },
      z.object({ write_enabled: z.boolean(), expires_at: z.string() }),
    );
    const banner = el(
      'aside',
      { class: 'assistance-banner', role: 'status' },
      el(
        'strong',
        {},
        `MODALITÀ ASSISTENZA · ${profile.display_name} (${profile.role}) · ${info.write_enabled ? 'INTERVENTO ABILITATO' : 'SOLA LETTURA'}`,
      ),
      button(
        'Esci dall’assistenza',
        async () => {
          await rpc('end_impersonation', { p_id: assistance }, z.null());
          sessionStorage.removeItem('plateform-impersonation');
          location.reload();
        },
        'secondary',
      ),
    );
    if (!info.write_enabled)
      banner.append(
        button(
          'Abilita intervento',
          () => {
            const check = el('input', { type: 'checkbox', required: '' });
            const popup = dialog(
              'Abilita intervento operativo',
              el(
                'label',
                {},
                check,
                'Confermo di intervenire con i permessi del collega. Ogni modifica conserverà entrambe le identità.',
              ),
            );
            popup.append(
              button('Conferma con password', async () => {
                if (!check.reportValidity()) return;
                const grant = await stepUp('IMPERSONATION', assistance);
                await rpc(
                  'enable_impersonation_write',
                  { p_id: assistance, p_confirm: true, p_grant: grant },
                  z.null(),
                );
                popup.close();
                await render();
              }),
            );
          },
          'secondary',
        ),
      );
    shell.prepend(banner);
    setTimeout(
      () => {
        sessionStorage.removeItem('plateform-impersonation');
        void render().catch(showError);
      },
      Math.max(0, Date.parse(info.expires_at) - Date.now()),
    );
  }
  app.replaceChildren(shell);
  void rpc('heartbeat_device', {}, z.boolean()).catch(() => undefined);
  void refreshNotificationIndicator();
  const refreshNotice = button(
    'Sono disponibili dati aggiornati. Aggiorna la vista',
    async () => {
      await currentContext?.refresh?.();
      refreshNotice.hidden = true;
    },
    'secondary',
  );
  refreshNotice.id = 'live-refresh';
  refreshNotice.hidden = true;
  main.prepend(refreshNotice);
  try {
    let content: HTMLElement;
    if (!pageLink)
      content = emptyState(
        'Vista non disponibile',
        'Utilizza le funzioni disponibili per il tuo ruolo.',
      );
    else if (pageLink.path === '/operazioni')
      content = await (
        await import('../../src/pages/admin-operations')
      ).adminOperationsPage(context);
    else if (pageLink.path === '/eccezioni')
      content = await (
        await import('../../src/pages/service-exceptions')
      ).serviceExceptionsPage(context);
    else if (pageLink.path === '/preparazione')
      content = await (
        await import('../../src/pages/restaurant-setup')
      ).restaurantSetupPage(context);
    else if (pageLink.path === '/food-cost')
      content = await (
        await import('../../src/pages/menu-engineering')
      ).menuEngineeringPage(context);
    else if (pageLink.path === '/menu-sede')
      content = await (await import('../../src/pages/venue-menu')).venueMenuPage(context);
    else if (pageLink.path === '/servizio')
      content = await (await import('../../src/pages/waiter')).waiterPage(context);
    else if (pageLink.path === '/sala')
      content = await (await import('../../src/pages/floor')).floorPage(context);
    else if (pageLink.path === '/accoglienza')
      content = await (await import('../../src/pages/host')).hostPage(context);
    else if (pageLink.path === '/conti')
      content = await (
        await import('../../src/pages/accounts')
      ).accountsPage(context, staffPath().split('/')[2]);
    else if (pageLink.path === '/cassa')
      content = await (await import('../../src/pages/cash')).cashPage(context);
    else if (pageLink.path === '/modifiche')
      content = await (await import('../../src/pages/order-changes')).orderChangesPage(context);
    else if (pageLink.path === '/editor')
      content = await (await import('../../src/pages/room-editor')).roomEditorPage(context);
    else if (pageLink.path === '/pianificazione')
      content = await (await import('../../src/pages/planning')).planningPage(context);
    else if (pageLink.path === '/gestione')
      content = await (await import('../../src/pages/configuration')).configurationPage(context);
    else if (pageLink.path === '/sito')
      content = await (await import('../../src/pages/branding')).brandingPage(context);
    else if (pageLink.path === '/impostazioni')
      content = await (
        await import('../../src/pages/operational-settings')
      ).operationalSettingsPage(context);
    else if (pageLink.path === '/privacy')
      content = await (await import('../../src/pages/privacy')).privacyPage(context);
    else if (pageLink.path === '/audit')
      content = await (await import('../../src/pages/audit')).auditPage();
    else if (pageLink.path === '/statistiche')
      content = await (await import('../../src/pages/statistics')).statisticsPage(context);
    else if (pageLink.path === '/conflitti')
      content = await (await import('../../src/pages/offline')).conflictPage(context);
    else if (pageLink.path === '/sedi')
      content = await (await import('../../src/pages/venues')).venuesPage(context);
    else if (pageLink.path === '/dispositivi')
      content = await (await import('../../src/pages/devices')).devicesPage(context);
    else if (pageLink.path === '/stampe')
      content = await (await import('../../src/pages/printing')).printingPage(context);
    else if (pageLink.path === '/staff')
      content = await (
        await import('../../src/pages/staff-management')
      ).staffManagementPage(context);
    else if (['/cucina', '/pass', '/consegne'].includes(pageLink.path))
      content = await (await import('../../src/pages/kitchen')).kitchenPage(context);
    else if (pageLink.path === '/notifiche')
      content = await (await import('../../src/pages/notifications')).notificationsPage(context);
    else content = await (await import('../../src/pages/technical')).technicalPage(context);
    if (revision === renderRevision && heading) {
      main.replaceChildren(heading, refreshNotice, content);
      const key = `${profile.id}:${context.venue?.id ?? ''}:${pageLink?.path ?? ''}`;
      if (key !== liveKey) {
        disconnectLive();
        liveKey = key;
        stopLive = watchLive({
          venueId: context.venue?.id ?? null,
          userId: profile.id,
          topics: [
            'PUBLIC',
            'FLOOR',
            'BOOKING',
            'ACCOUNT',
            'KITCHEN',
            'FINANCE',
            'CALL',
            'NOTIFICATION',
            'CONFIG',
          ],
          refresh: refreshVisiblePage,
          accessChanged: async (signaled) => {
            const info = await requirements();
            if (!info || !info.session_unlocked || !info.active || signaled) await render();
          },
          state: (state) => {
            connectionState = state;
            const label = document.getElementById('connection-state');
            if (label) label.textContent = connectionLabel();
          },
        });
      }
    }
  } catch (error) {
    if (revision === renderRevision && heading)
      main.replaceChildren(
        heading,
        emptyState('Impossibile caricare questa vista', 'Controlla la connessione e riprova.'),
        button('Riprova', render),
      );
    showError(error);
  }
}

function openProfile(): void {
  if (!currentContext) return;
  const popup = dialog(
    currentContext.profile.display_name,
    button(
      'Prepara uso offline',
      async () => {
        await (await import('../../src/pages/offline')).prepareOffline(currentContext!);
      },
      'secondary',
    ),
    button(
      'Imposta o modifica PIN',
      () => {
        popup.close();
        editPin();
      },
      'secondary',
    ),
    button(
      'Sicurezza account',
      async () => {
        popup.close();
        await openAccessSecurity(async () => {
          await signOut();
          navigate('/login');
        });
      },
      'secondary',
    ),
    button(
      'Cambia tema',
      () => {
        const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('plateform-theme', theme);
      },
      'secondary',
    ),
    button(
      'Esci',
      async () => {
        await signOut();
        popup.close();
        navigate('/login');
      },
      'secondary',
    ),
  );
}

function openPalette(): void {
  const search = field('Cerca tavoli, conti, prenotazioni o funzioni', 'command');
  const list = el('div', { class: 'stack' });
  const popup = dialog('Vai a…', search.root, list);
  const resources = el('div', { class: 'stack', 'aria-live': 'polite' });
  popup.append(resources);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const hitSchema = z.array(
    z.object({
      kind: z.string(),
      id: z.uuid(),
      label: z.string(),
      path: z.string(),
      venue_id: z.uuid().nullable(),
    }),
  );
  const update = () => {
    list.replaceChildren(
      ...navigation
        .filter(
          (entry) =>
            currentContext &&
            entry.roles.includes(currentContext.profile.role) &&
            entry.label.toLowerCase().includes(search.input.value.toLowerCase()),
        )
        .map((entry) =>
          button(
            entry.label,
            () => {
              popup.close();
              navigate(entry.path);
            },
            'secondary',
          ),
        ),
    );
  };
  search.input.addEventListener('input', () => {
    update();
    clearTimeout(timer);
    const current = ++generation,
      query = search.input.value.trim();
    resources.replaceChildren();
    if (query.length < 2) return;
    timer = setTimeout(() => {
      void rpc(
        'search_operational_resources',
        { p_query: query, p_venue: currentContext?.venue?.id ?? null },
        hitSchema,
      )
        .then((hits) => {
          if (current !== generation || !popup.open) return;
          const labels: Record<string, string> = {
            TABLE: 'Tavolo',
            ACCOUNT: 'Conto',
            RESERVATION: 'Prenotazione',
            DISH: 'Piatto',
            STAFF: 'Collega',
            REGISTER: 'Cassa',
            VENUE: 'Sede',
          };
          resources.replaceChildren(
            el('h3', {}, 'Risultati autorizzati'),
            ...hits.map((hit) =>
              button(
                `${hit.label} · ${labels[hit.kind] ?? hit.kind}`,
                () => {
                  if (
                    hit.venue_id &&
                    currentContext?.venues.some((venue) => venue.id === hit.venue_id)
                  )
                    sessionStorage.setItem('plateform-venue', hit.venue_id);
                  popup.close();
                  navigate(hit.path);
                },
                'secondary',
              ),
            ),
          );
          if (!hits.length) resources.append(el('p', {}, 'Nessun risultato nel tuo ambito.'));
        })
        .catch(showError);
    }, 250);
  });
  popup.addEventListener('close', () => {
    clearTimeout(timer);
    generation++;
  });
  update();
  search.input.focus();
}

document.documentElement.dataset.theme = localStorage.getItem('plateform-theme') ?? 'light';
// Native anchor scrolling does not reliably focus the main landmark in all browsers.
document.querySelector('a.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  document.getElementById('main')?.focus();
});
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('a') : null;
  if (
    !(target instanceof HTMLAnchorElement) ||
    target.origin !== location.origin ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  )
    return;
  if (
    target.hash ||
    target.download ||
    target.target === '_blank' ||
    !target.pathname.startsWith(staffBase)
  )
    return;
  event.preventDefault();
  navigate(target.pathname.slice(staffBase.length - 1) + target.search);
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && currentContext) {
    event.preventDefault();
    openPalette();
  }
  const editing =
    event.target instanceof Element &&
    event.target.matches('input,textarea,select,[contenteditable]');
  if (currentContext && !editing && !document.querySelector('dialog[open]')) {
    if (event.key === 'F2' && ['ADMIN', 'CASHIER'].includes(currentContext.profile.role)) {
      event.preventDefault();
      navigate('/conti');
    }
    if (
      event.key === '/' &&
      ['ADMIN', 'CASHIER', 'HOST', 'SUPER_ADMIN'].includes(currentContext.profile.role)
    ) {
      event.preventDefault();
      openPalette();
    }
  }
});
window.addEventListener('popstate', () => {
  void render().catch(showError);
});
void render().catch((error: unknown) => {
  app.replaceChildren(
    el(
      'main',
      { id: 'main', class: 'workspace' },
      emptyState('Accesso momentaneamente non disponibile', 'Verifica la connessione e riprova.'),
      button('Riprova', render),
    ),
  );
  showError(error);
});

window.addEventListener('online', () => {
  void (async () => {
    const offline = await import('../../src/pages/offline');
    await offline.syncQueue();
    await render();
    if (currentContext) await offline.reconcileAfterReconnect(currentContext);
  })().catch(showError);
});
window.addEventListener('offline', () => {
  if (!document.querySelector('dialog[open]')) void render().catch(showError);
});

void registerPwa().catch(() => {});
