import { z } from 'zod';
import { client, readRows, rpc, safeError } from '../api/client';
import { button, dialog, el, field, showError, status, toast } from '../components/dom';
import type { StaffContext } from './staff-context';
import { stepUp } from '../auth/step-up';
import { externalPaymentProvidersIncluded } from '../services/commercial-scope';
const record = z.record(z.string(), z.unknown());

export async function technicalPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venues.length) {
    const name = field('Nome del ristorante o della catena', 'name');
    const publicUrl = field('Dominio pubblico', 'public_url', 'url', 'https://');
    const staffUrl = field('Dominio staff', 'staff_url', 'url', 'https://staff.');
    const identity = field('Dominio identificativi staff', 'identity');
    const venue = field('Nome prima sede', 'venue');
    const slug = field('Nome breve per l’indirizzo della sede', 'slug');
    const address = field('Indirizzo', 'address');
    const phone = field('Telefono', 'phone', 'tel');
    for (const input of [name, publicUrl, staffUrl, identity, venue, slug, address, phone])
      input.input.required = true;
    return el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Configura l’installazione'),
      el(
        'p',
        { class: 'muted' },
        'Un solo brand, una prima sede. Domini e identificativi restano configurabili separatamente.',
      ),
      ...[name, publicUrl, staffUrl, identity, venue, slug, address, phone].map(
        (input) => input.root,
      ),
      button('Crea ristorante e prima sede', async () => {
        if (
          [name, publicUrl, staffUrl, identity, venue, slug, address, phone].some(
            (input) => !input.input.reportValidity(),
          )
        )
          return;
        await rpc(
          'setup_installation',
          {
            p_name: name.input.value,
            p_public_url: publicUrl.input.value,
            p_staff_url: staffUrl.input.value,
            p_identity_domain: identity.input.value,
            p_venue: {
              name: venue.input.value,
              slug: slug.input.value,
              code: 'MAIN',
              address: address.input.value,
              phone: phone.input.value,
            },
          },
          z.uuid(),
        );
        toast('Installazione creata.');
        location.reload();
      }),
    );
  }
  const data = await rpc(
    'get_technical_workspace',
    {},
    z.object({
      profile: record,
      settings: record,
      limits: record,
      features: z.array(
        z.object({ name: z.string(), licensed: z.boolean(), version: z.number().int() }),
      ),
      health: z.array(
        z.object({
          component: z.string(),
          status: z.string(),
          latency_ms: z.number().nullable(),
          checked_at: z.string(),
          code: z.string(),
        }),
      ),
      backups: z.array(record),
      restores: z.array(record),
      backup_health: z.object({
        last_success_at: z.string().nullable(),
        last_failure_at: z.string().nullable(),
        last_restore_test_at: z.string().nullable(),
        last_backup_duration_seconds: z.number().int().nullable(),
        backup_age_minutes: z.number().nullable(),
        last_restore_test_duration_seconds: z.number().int().nullable(),
        rpo_within_target: z.boolean(),
        rto_last_test_within_target: z.boolean().nullable(),
        pending_count: z.number().int(),
        failed_24h: z.number().int(),
        expiring_7d: z.number().int(),
        expired_unpurged_count: z.number().int(),
        purge_in_progress_count: z.number().int(),
        purge_failed_count: z.number().int(),
        last_artifacts_purged_at: z.string().nullable(),
        latest_purge_error_code: z.string().nullable(),
        latest_status: z.string().nullable(),
        latest_integrity_verified: z.boolean().nullable(),
        latest_retention_until: z.string().nullable(),
        restore_pending_count: z.number().int(),
        restore_failed_24h: z.number().int(),
        latest_restore_status: z.string().nullable(),
        cron_active: z.boolean(),
        cron_schedule: z.string().nullable(),
      }),
      continuity_targets: z.object({
        rpo_target_minutes: z.number().int(),
        rto_target_minutes: z.number().int(),
        backup_retention_days: z.number().int(),
        restore_test_interval_days: z.number().int(),
        version: z.number().int(),
      }),
      releases: z.array(record),
      schema_version: z.string().nullable(),
      incidents: z.array(record),
      usage: z.record(z.string(), z.number()),
      queues: z.record(z.string(), z.number()),
      metrics: z.object({
        requests: z.number().int(),
        failures: z.number().int(),
        error_percent: z.number().nullable(),
        latency_p95_ms: z.number().nullable(),
        latest_at: z.string().nullable(),
      }),
    }),
  );
  const cutoverPendingCount = data.restores.filter(
    (row) => row.mode === 'RESTORE' && row.status === 'CUTOVER_REQUIRED',
  ).length;
  const view = el('div', { class: 'stack' });
  const continuityIncidents = data.incidents
    .filter((incident) => String(incident.automation_key ?? '').startsWith('CONTINUITY_'))
    .sort((a, b) => {
      const rank: Record<string, number> = {
        CRITICAL: 5,
        INCIDENT: 4,
        DEGRADED: 3,
        WARNING: 2,
        INFO: 1,
      };
      return (rank[String(b.severity)] ?? 0) - (rank[String(a.severity)] ?? 0);
    });
  if (continuityIncidents.length) {
    const primary = continuityIncidents[0]!,
      urgent = ['CRITICAL', 'INCIDENT'].includes(String(primary.severity));
    view.append(
      el(
        'section',
        { class: `incident-banner ${urgent ? 'critical' : 'warning'}`, role: 'alert' },
        el(
          'div',
          { class: 'stack compact' },
          el(
            'strong',
            {},
            `${continuityIncidents.length} alert di continuità ${continuityIncidents.length === 1 ? 'attivo' : 'attivi'}`,
          ),
          el('span', {}, String(primary.title)),
          el('span', { class: 'muted' }, String(primary.impact)),
        ),
        status(String(primary.severity)),
        button('Gestisci', () => editIncident(primary), 'secondary'),
      ),
    );
  }
  const coreComponents = ['DATABASE', 'AUTH', 'REALTIME', 'STORAGE', 'EDGE'] as const;
  const coreProbes = coreComponents.map((component) => ({
    component,
    probe: data.health.find((row) => row.component === component),
  }));
  const fresh = (checkedAt: string) => Date.now() - Date.parse(checkedAt) <= 300000;
  const healthyCore = coreProbes.filter(
    ({ probe }) => probe?.status === 'HEALTHY' && fresh(probe.checked_at),
  ).length;
  const hasUnavailable = coreProbes.some(({ probe }) => probe?.status === 'UNAVAILABLE');
  const hasDegraded = coreProbes.some(({ probe }) => probe?.status === 'DEGRADED');
  const hasUnknown = coreProbes.some(
    ({ probe }) =>
      !probe || !fresh(probe.checked_at) || ['UNVERIFIED', 'DISABLED'].includes(probe.status),
  );
  const overallHealth = hasUnavailable
    ? 'CRITICAL'
    : hasDegraded
      ? 'ATTENZIONE'
      : hasUnknown
        ? 'DA VERIFICARE'
        : 'OPERATIVO';
  const currentRelease =
    data.releases.find((row) => ['RELEASED', 'STAGING'].includes(String(row.status))) ??
    data.releases[0];
  const totalQueue = Object.values(data.queues).reduce((sum, value) => sum + value, 0);
  const recentDevices = Number(data.usage.recent_devices ?? 0);
  const totalDevices = Number(data.usage.devices ?? 0);
  const operationalHealth = el(
    'section',
    {
      class: `technical-hero is-${overallHealth.toLowerCase().replaceAll(' ', '-')}`,
      'aria-label': 'Operational Health',
    },
    el(
      'div',
      { class: 'technical-hero-head' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, 'PLATEFORM TECHNICAL CONTROL'),
        el('h1', {}, 'Operational Health'),
        el(
          'p',
          { class: 'muted' },
          'Stato tecnico dell’installazione. Nessun KPI economico del ristorante.',
        ),
      ),
      status(overallHealth),
    ),
    el(
      'div',
      { class: 'technical-health-grid' },
      el(
        'article',
        { class: 'technical-health-card' },
        el('span', {}, 'VERSIONE'),
        el('strong', {}, String(currentRelease?.version ?? 'N/D')),
        el('small', {}, `Schema ${data.schema_version ?? 'N/D'}`),
      ),
      el(
        'article',
        { class: 'technical-health-card' },
        el('span', {}, 'CORE SUPABASE'),
        el('strong', {}, `${healthyCore}/${coreComponents.length}`),
        el('small', {}, coreComponents.join(' · ')),
      ),
      el(
        'article',
        { class: 'technical-health-card' },
        el('span', {}, 'EDGE ERROR RATE'),
        el('strong', {}, data.metrics.latest_at ? `${data.metrics.error_percent ?? 0}%` : 'N/D'),
        el(
          'small',
          {},
          data.metrics.latest_at
            ? `${data.metrics.failures}/${data.metrics.requests} errori`
            : 'Misura non disponibile',
        ),
      ),
      el(
        'article',
        { class: 'technical-health-card' },
        el('span', {}, 'LATENZA P95'),
        el(
          'strong',
          {},
          data.metrics.latency_p95_ms === null ? 'N/D' : `${data.metrics.latency_p95_ms} ms`,
        ),
        el('small', {}, data.metrics.latest_at ? 'ultimi 15 minuti' : 'misura non disponibile'),
      ),
      el(
        'article',
        { class: 'technical-health-card' },
        el('span', {}, 'DISPOSITIVI'),
        el('strong', {}, `${recentDevices}/${totalDevices}`),
        el('small', {}, 'attivi negli ultimi 5 min / autorizzati'),
      ),
      el(
        'article',
        { class: 'technical-health-card' },
        el('span', {}, 'CODE / CONFLITTI'),
        el('strong', {}, String(totalQueue)),
        el('small', {}, `${Number(data.queues.sync_conflicts ?? 0)} conflitti aperti`),
      ),
      el(
        'article',
        { class: 'technical-health-card' },
        el('span', {}, 'RPO'),
        el('strong', {}, data.backup_health.rpo_within_target ? 'ENTRO TARGET' : 'FUORI TARGET'),
        el(
          'small',
          {},
          data.backup_health.backup_age_minutes === null
            ? 'backup non misurato'
            : `${data.backup_health.backup_age_minutes} min dall’ultimo backup`,
        ),
      ),
      el(
        'article',
        { class: 'technical-health-card' },
        el('span', {}, 'RESTORE'),
        el('strong', {}, data.backup_health.latest_restore_status ?? 'N/D'),
        el(
          'small',
          {},
          `${data.backup_health.restore_pending_count} pending · ${data.backup_health.restore_failed_24h} falliti 24h`,
        ),
      ),
    ),
    el(
      'nav',
      { class: 'technical-shortcuts', 'aria-label': 'Scorciatoie tecniche' },
      button(
        'SERVIZI',
        () => document.getElementById('technical-health')?.scrollIntoView({ behavior: 'smooth' }),
        'secondary',
      ),
      button(
        'CONTINUITÀ',
        () =>
          document.getElementById('technical-continuity')?.scrollIntoView({ behavior: 'smooth' }),
        'secondary',
      ),
      button(
        'CODE',
        () => document.getElementById('technical-queues')?.scrollIntoView({ behavior: 'smooth' }),
        'secondary',
      ),
      button('DISPOSITIVI', () => context.navigate('/dispositivi'), 'secondary'),
      button('AUDIT', () => context.navigate('/audit'), 'secondary'),
    ),
  );
  view.append(operationalHealth);

  const logSource = el(
    'select',
    { 'aria-label': 'Origine log tecnico' },
    ...[
      ['ALL', 'Tutte le origini'],
      ['ERROR', 'Errori applicativi'],
      ['EDGE', 'Richieste Edge'],
      ['HEALTH', 'Anomalie di salute'],
      ['AUTH', 'Audit nativo Supabase Auth'],
    ].map(([value, name]) => el('option', { value: value ?? '' }, name ?? '')),
  );
  const logPeriod = el(
    'select',
    { 'aria-label': 'Periodo log tecnico' },
    ...[
      ['1', 'Ultime 24 ore'],
      ['7', 'Ultimi 7 giorni'],
      ['30', 'Ultimi 30 giorni'],
    ].map(([value, name]) =>
      el(
        'option',
        { value: value ?? '', ...(value === '7' ? { selected: 'selected' } : {}) },
        name ?? '',
      ),
    ),
  );
  const technicalLogRows = el('tbody');
  const logFeedback = el('p', { class: 'muted', role: 'status' });
  const logMore = button('Carica log precedenti', () => fetchTechnicalLogs(true), 'secondary');
  logMore.hidden = true;
  let technicalCursor: { occurred_at: string; entry_key: string } | null = null;
  let technicalLogRevision = 0;
  let logWindow: { start: string; end: string; source: string } | null = null;
  async function fetchTechnicalLogs(append = false): Promise<void> {
    const revision = ++technicalLogRevision;
    if (!append || !logWindow) {
      technicalCursor = null;
      const end = new Date();
      const days = Number(logPeriod.value);
      logWindow = {
        start: new Date(end.getTime() - days * 86_400_000).toISOString(),
        end: end.toISOString(),
        source: logSource.value,
      };
    }
    const data = await rpc(
      'search_technical_logs',
      {
        p_source: logWindow.source,
        p_from: logWindow.start,
        p_to: logWindow.end,
        p_before_at: technicalCursor?.occurred_at ?? null,
        p_before_key: technicalCursor?.entry_key ?? null,
        p_limit: 50,
      },
      z.object({
        events: z.array(
          z.object({
            occurred_at: z.string(),
            source: z.string(),
            severity: z.string(),
            result: z.string(),
            operation: z.string(),
            code: z.string(),
            request_id: z.uuid().nullable(),
            correlation_id: z.uuid().nullable(),
            entry_key: z.string(),
            latency_ms: z.number().nullable(),
            environment: z.string().nullable(),
            release_version: z.string().nullable(),
          }),
        ),
        has_more: z.boolean(),
      }),
    );
    if (revision !== technicalLogRevision) return;
    if (!append) technicalLogRows.replaceChildren();
    for (const event of data.events) {
      technicalLogRows.append(
        el(
          'tr',
          {},
          el('td', {}, new Date(event.occurred_at).toLocaleString('it-IT')),
          el('td', {}, event.source),
          el('td', {}, status(event.severity)),
          el('td', {}, event.operation),
          el('td', {}, event.code),
          el('td', {}, event.request_id ?? '—'),
          el('td', {}, event.latency_ms === null ? '—' : String(event.latency_ms) + ' ms'),
        ),
      );
    }
    const last = data.events.at(-1);
    technicalCursor = last ? { occurred_at: last.occurred_at, entry_key: last.entry_key } : null;
    logMore.hidden = !data.has_more;
    logFeedback.textContent = technicalLogRows.childElementCount
      ? String(technicalLogRows.childElementCount) +
        ' righe caricate. I dettagli tecnici sono minimizzati.'
      : 'Nessun evento in questo periodo. Assenza di log non significa che il servizio sia verificato.';
  }
  const technicalLogs = el(
    'section',
    { class: 'card stack', id: 'technical-logs' },
    el('h2', {}, 'Log tecnici e anomalie'),
    el(
      'p',
      { class: 'muted' },
      'Registri separati dall’audit immutabile: errori applicativi, Edge, controlli di salute e azioni native Supabase Auth. Le azioni Auth sono eventi non classificati per esito; la scrittura nel database dipende dalle impostazioni Supabase. Nessun payload, IP o segreto.',
    ),
    el(
      'div',
      { class: 'row wrap' },
      el('label', { class: 'field' }, 'Origine', logSource),
      el('label', { class: 'field' }, 'Periodo', logPeriod),
      button('Aggiorna log', () => fetchTechnicalLogs().catch(showError), 'secondary'),
    ),
    logFeedback,
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            ...['Data', 'Origine', 'Gravità', 'Operazione', 'Codice', 'Richiesta', 'Latenza'].map(
              (title) => el('th', {}, title),
            ),
          ),
        ),
        technicalLogRows,
      ),
    ),
    logMore,
  );
  view.append(technicalLogs);
  void fetchTechnicalLogs().catch(showError);

  const latest =
      data.releases.find((row) => ['RELEASED', 'STAGING'].includes(String(row.status))) ??
      data.releases[0],
    backup = data.backups.find((row) => row.status === 'SUCCEEDED'),
    restore = data.backups
      .filter((row) => row.last_restore_test_at)
      .sort((a, b) =>
        String(b.last_restore_test_at).localeCompare(String(a.last_restore_test_at)),
      )[0];
  view.append(
    el(
      'div',
      { class: 'kpi-grid' },
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Applicazione'),
        el('p', {}, String(latest?.version ?? 'Release non registrata')),
        status(String(latest?.status ?? 'DA VERIFICARE')),
        el('p', {}, `Schema: ${data.schema_version ?? 'migrazioni non registrate'}`),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Ultimo backup riuscito'),
        el(
          'p',
          {},
          backup?.completed_at
            ? new Date(String(backup.completed_at)).toLocaleString('it-IT')
            : 'Nessuna esecuzione registrata',
        ),
        status(backup?.integrity_verified === true ? 'INTEGRITÀ VERIFICATA' : 'NON VERIFICATO'),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Ultimo restore test'),
        el(
          'p',
          {},
          restore?.last_restore_test_at
            ? new Date(String(restore.last_restore_test_at)).toLocaleString('it-IT')
            : 'Da eseguire',
        ),
        status(restore?.last_restore_test_at ? 'VERIFICATO' : 'DA ESEGUIRE'),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Backup automatico'),
        status(data.backup_health.cron_active ? 'CRON ATTIVO' : 'CRON NON ATTIVO'),
        el(
          'p',
          {},
          `Controllo scheduler: ${data.backup_health.cron_schedule ?? 'non disponibile'}`,
        ),
        el('p', {}, `${data.backup_health.pending_count} backup in coda/esecuzione`),
        el('p', {}, `${data.backup_health.failed_24h} fallimenti nelle ultime 24 ore`),
      ),
    ),
  );

  const continuity = el(
    'section',
    { class: 'card stack', id: 'technical-continuity' },
    el('h2', {}, 'Continuità operativa'),
    el(
      'p',
      { class: 'muted' },
      'Lo stato deriva dai job server-side. Un backup è recuperabile soltanto dopo verifica di database/Auth/Storage e manifest; la presenza di una riga non equivale a un backup riuscito.',
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Target RPO'),
      el('strong', {}, `${data.continuity_targets.rpo_target_minutes} min · obiettivo, non SLA`),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'RPO osservato / età ultimo backup verificato'),
      el(
        'strong',
        {},
        data.backup_health.backup_age_minutes === null
          ? 'Non misurabile: nessun backup verificato'
          : `${data.backup_health.backup_age_minutes} min`,
      ),
      status(data.backup_health.rpo_within_target ? 'ENTRO TARGET' : 'FUORI TARGET'),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Target RTO'),
      el('strong', {}, `${data.continuity_targets.rto_target_minutes} min · obiettivo, non SLA`),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'RTO osservato / ultimo restore test'),
      el(
        'strong',
        {},
        data.backup_health.last_restore_test_duration_seconds === null
          ? 'Non misurabile: restore test non eseguito'
          : `${Math.round(data.backup_health.last_restore_test_duration_seconds / 60)} min`,
      ),
      status(
        data.backup_health.rto_last_test_within_target === null
          ? 'DA MISURARE'
          : data.backup_health.rto_last_test_within_target
            ? 'ENTRO TARGET'
            : 'FUORI TARGET',
      ),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Ultima durata backup'),
      el(
        'strong',
        {},
        data.backup_health.last_backup_duration_seconds === null
          ? 'Non misurata'
          : `${Math.round(data.backup_health.last_backup_duration_seconds / 60)} min`,
      ),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Ultimo fallimento backup'),
      el(
        'strong',
        {},
        data.backup_health.last_failure_at
          ? new Date(data.backup_health.last_failure_at).toLocaleString('it-IT')
          : 'Nessuno registrato',
      ),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Retention ultimo backup'),
      el(
        'strong',
        {},
        data.backup_health.latest_retention_until
          ? new Date(data.backup_health.latest_retention_until).toLocaleString('it-IT')
          : 'Non disponibile',
      ),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Backup in scadenza entro 7 giorni'),
      el('strong', {}, data.backup_health.expiring_7d),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Backup scaduti con artefatti ancora presenti'),
      el('strong', {}, data.backup_health.expired_unpurged_count),
      status(data.backup_health.expired_unpurged_count ? 'DA ELIMINARE' : 'OK'),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Purge retention in corso'),
      el('strong', {}, data.backup_health.purge_in_progress_count),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Errori retention aperti'),
      el('strong', {}, data.backup_health.purge_failed_count),
      status(data.backup_health.purge_failed_count ? 'ATTENZIONE' : 'OK'),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Ultimo purge artefatti'),
      el(
        'strong',
        {},
        data.backup_health.last_artifacts_purged_at
          ? new Date(data.backup_health.last_artifacts_purged_at).toLocaleString('it-IT')
          : 'Nessuno ancora',
      ),
    ),
    data.backup_health.latest_purge_error_code
      ? el(
          'div',
          { class: 'row between' },
          el('span', {}, 'Ultimo errore retention'),
          el('strong', {}, data.backup_health.latest_purge_error_code),
        )
      : null,
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Restore attivi'),
      el('strong', {}, data.backup_health.restore_pending_count),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Cutover replacement verificato in attesa'),
      el('strong', {}, cutoverPendingCount),
      status(cutoverPendingCount ? 'AZIONE RICHIESTA' : 'NESSUNO'),
    ),
    el(
      'div',
      { class: 'row between' },
      el('span', {}, 'Restore falliti nelle ultime 24 ore'),
      el('strong', {}, data.backup_health.restore_failed_24h),
    ),
  );

  continuity.append(
    button(
      'Configura obiettivi RPO/RTO',
      () => {
        const rpo = field(
            'Target RPO (minuti)',
            'rpo-target',
            'number',
            String(data.continuity_targets.rpo_target_minutes),
          ),
          rto = field(
            'Target RTO (minuti)',
            'rto-target',
            'number',
            String(data.continuity_targets.rto_target_minutes),
          ),
          retention = field(
            'Retention backup (giorni)',
            'backup-retention',
            'number',
            String(data.continuity_targets.backup_retention_days),
          ),
          restoreInterval = field(
            'Intervallo restore test (giorni)',
            'restore-test-interval',
            'number',
            String(data.continuity_targets.restore_test_interval_days),
          ),
          popup = dialog(
            'Obiettivi di continuità',
            el(
              'p',
              { class: 'muted' },
              'Questi valori sono obiettivi operativi. Non diventano SLA o garanzie finché backup e restore test reali non li dimostrano.',
            ),
            rpo.root,
            rto.root,
            retention.root,
            restoreInterval.root,
          ),
          key = crypto.randomUUID();
        Object.assign(rpo.input, { min: '5', max: '1440', required: true });
        Object.assign(rto.input, { min: '15', max: '1440', required: true });
        Object.assign(retention.input, { min: '1', max: '90', required: true });
        Object.assign(restoreInterval.input, { min: '1', max: '90', required: true });
        popup.append(
          button('Salva obiettivi', async () => {
            if (
              [rpo, rto, retention, restoreInterval].some(
                (control) => !control.input.reportValidity(),
              )
            )
              return;
            await rpc(
              'configure_continuity_targets',
              {
                p_version: data.continuity_targets.version,
                p_rpo_target_minutes: Number(rpo.input.value),
                p_rto_target_minutes: Number(rto.input.value),
                p_backup_retention_days: Number(retention.input.value),
                p_restore_test_interval_days: Number(restoreInterval.input.value),
                p_key: key,
              },
              z.object({ version: z.number().int() }),
            );
            popup.close();
            toast('Obiettivi di continuità aggiornati.');
            await context.refresh?.();
          }),
        );
      },
      'secondary',
    ),
    button('Crea backup manuale', async () => {
      await rpc(
        'create_backup',
        {
          p_purpose: 'MANUAL',
          p_retention_days: data.continuity_targets.backup_retention_days,
          p_key: crypto.randomUUID(),
        },
        z.object({ id: z.uuid(), status: z.string() }),
      );
      toast('Backup accodato. Sarà verificato dal worker prima di risultare recuperabile.');
      await context.refresh?.();
    }),
  );

  if (data.backups.length) {
    continuity.append(el('h3', {}, 'Ultimi backup'));
    for (const row of data.backups.slice(0, 5)) {
      const backupId = z.uuid().safeParse(row.id),
        eligible =
          backupId.success &&
          row.status === 'SUCCEEDED' &&
          row.integrity_verified === true &&
          row.includes_auth === true &&
          row.includes_storage === true &&
          !row.artifacts_purged_at &&
          (!row.retention_until || Date.parse(String(row.retention_until)) > Date.now());
      const actions = el(
        'div',
        { class: 'row' },
        eligible
          ? button(
              'Restore test',
              async () => {
                const grant = await stepUp('RESTORE', backupId.data);
                await rpc(
                  'request_restore_test',
                  { p_backup: backupId.data, p_step_up: grant, p_key: crypto.randomUUID() },
                  z.object({ id: z.uuid(), status: z.string(), mode: z.string() }),
                );
                toast('Restore test accodato su target isolato.');
                await context.refresh?.();
              },
              'secondary',
            )
          : null,
        eligible
          ? button(
              'Ripristina',
              () => {
                const reason = field('Motivo del ripristino', 'restore-reason'),
                  restaurant = field(
                    'Scrivi il nome del ristorante per confermare',
                    'restore-name',
                  );
                reason.input.required = true;
                reason.input.minLength = 10;
                restaurant.input.required = true;
                const popup = dialog(
                  'Ripristino installazione',
                  el(
                    'p',
                    {},
                    'Operazione distruttiva: Plateform creerà prima un backup di sicurezza verificato. Il ripristino non partirà se quello snapshot fallisce.',
                  ),
                  el(
                    'p',
                    { class: 'muted' },
                    'Ambito: intera installazione. Il restore parziale non è consentito finché non esiste una procedura separata verificata.',
                  ),
                  reason.root,
                  restaurant.root,
                );
                popup.append(
                  button('Conferma ripristino', async () => {
                    if (!reason.input.reportValidity() || !restaurant.input.reportValidity())
                      return;
                    if (restaurant.input.value.trim() !== String(data.profile.name ?? '').trim()) {
                      toast('Il nome del ristorante non corrisponde.');
                      return;
                    }
                    const requested = await rpc(
                      'request_restore',
                      { p_backup: backupId.data, p_key: crypto.randomUUID() },
                      z.object({ id: z.uuid(), status: z.string(), requires_step_up: z.boolean() }),
                    );
                    const grant = await stepUp('RESTORE', requested.id);
                    await rpc(
                      'confirm_restore',
                      {
                        p_restore: requested.id,
                        p_step_up: grant,
                        p_reason: reason.input.value.trim(),
                        p_key: crypto.randomUUID(),
                      },
                      z.object({
                        id: z.uuid(),
                        status: z.string(),
                        pre_restore_backup_id: z.uuid(),
                      }),
                    );
                    popup.close();
                    toast(
                      'Ripristino confermato. È stato accodato prima lo snapshot di sicurezza.',
                    );
                    await context.refresh?.();
                  }),
                );
              },
              'danger',
            )
          : null,
      );
      continuity.append(
        el(
          'div',
          { class: 'row between' },
          el(
            'span',
            {},
            `${String(row.purpose ?? 'BACKUP')} · ${new Date(String(row.created_at)).toLocaleString('it-IT')}`,
          ),
          status(String(row.status ?? 'UNKNOWN')),
          row.error_code ? el('span', { class: 'muted' }, String(row.error_code)) : null,
          actions,
        ),
      );
    }
  }
  if (data.restores.length) {
    continuity.append(el('h3', {}, 'Ultimi restore / restore test'));
    for (const row of data.restores.slice(0, 5)) {
      const restoreId = z.uuid().safeParse(row.id),
        targetReference = typeof row.target_reference === 'string' ? row.target_reference : '',
        targetProjectRef = /^supabase:\/\/([^/]+)\//.exec(targetReference)?.[1] ?? '',
        cutoverRequired = row.mode === 'RESTORE' && row.status === 'CUTOVER_REQUIRED';
      const cutoverActions =
        cutoverRequired && restoreId.success && targetReference && targetProjectRef
          ? el(
              'div',
              { class: 'row' },
              button(
                'Conferma cutover',
                () => {
                  const note = field('Nota di cutover / smoke test eseguiti', 'cutover-note'),
                    restaurant = field(
                      'Scrivi il nome del ristorante per confermare',
                      'cutover-restaurant',
                    ),
                    target = field('Scrivi il project ref replacement', 'cutover-target');
                  note.input.required = true;
                  note.input.minLength = 10;
                  restaurant.input.required = true;
                  target.input.required = true;
                  const popup = dialog(
                    'Conferma cutover del restore',
                    el(
                      'p',
                      {},
                      'Conferma solo dopo riallineamento Edge Functions, secrets, Auth/Realtime, hosting e smoke test sul replacement. Questa azione chiude il restore come riuscito.',
                    ),
                    el('p', { class: 'muted' }, `Target verificato: ${targetProjectRef}`),
                    note.root,
                    restaurant.root,
                    target.root,
                  );
                  popup.append(
                    button(
                      'Cutover completato',
                      async () => {
                        if (
                          !note.input.reportValidity() ||
                          !restaurant.input.reportValidity() ||
                          !target.input.reportValidity()
                        )
                          return;
                        if (
                          restaurant.input.value.trim() !== String(data.profile.name ?? '').trim()
                        ) {
                          toast('Il nome del ristorante non corrisponde.');
                          return;
                        }
                        if (target.input.value.trim() !== targetProjectRef) {
                          toast('Il project ref replacement non corrisponde al target verificato.');
                          return;
                        }
                        const grant = await stepUp('RESTORE', restoreId.data);
                        await rpc(
                          'confirm_restore_cutover',
                          {
                            p_restore: restoreId.data,
                            p_step_up: grant,
                            p_target_reference: targetReference,
                            p_note: note.input.value.trim(),
                            p_key: crypto.randomUUID(),
                          },
                          z.object({
                            id: z.uuid(),
                            status: z.literal('SUCCEEDED'),
                            target_reference: z.string(),
                          }),
                        );
                        popup.close();
                        toast('Cutover confermato. Restore chiuso come riuscito.');
                        await context.refresh?.();
                      },
                      'danger',
                    ),
                  );
                },
                'danger',
              ),
              button(
                'Abbandona cutover',
                () => {
                  const reason = field('Motivo dell’abbandono / rollback', 'cutover-abort-reason');
                  reason.input.required = true;
                  reason.input.minLength = 10;
                  const popup = dialog(
                    'Abbandona cutover',
                    el(
                      'p',
                      {},
                      'Usa questa azione se il replacement verificato non deve diventare attivo o se il cutover è stato annullato/riportato alla sorgente.',
                    ),
                    reason.root,
                  );
                  popup.append(
                    button(
                      'Conferma abbandono',
                      async () => {
                        if (!reason.input.reportValidity()) return;
                        const grant = await stepUp('RESTORE', restoreId.data);
                        await rpc(
                          'abort_restore_cutover',
                          {
                            p_restore: restoreId.data,
                            p_step_up: grant,
                            p_reason: reason.input.value.trim(),
                            p_key: crypto.randomUUID(),
                          },
                          z.object({
                            id: z.uuid(),
                            status: z.literal('FAILED'),
                            error_code: z.literal('CUTOVER_ABORTED'),
                          }),
                        );
                        popup.close();
                        toast('Cutover abbandonato. Restore marcato come fallito.');
                        await context.refresh?.();
                      },
                      'secondary',
                    ),
                  );
                },
                'secondary',
              ),
            )
          : null;
      continuity.append(
        el(
          'div',
          { class: 'stack compact' },
          el(
            'div',
            { class: 'row between' },
            el(
              'span',
              {},
              `${String(row.mode ?? 'RESTORE')} · ${new Date(String(row.created_at)).toLocaleString('it-IT')}`,
            ),
            status(String(row.status ?? 'UNKNOWN')),
            row.error_code ? el('span', { class: 'muted' }, String(row.error_code)) : null,
          ),
          targetReference ? el('span', { class: 'muted' }, `Target: ${targetReference}`) : null,
          cutoverActions,
        ),
      );
    }
  }
  view.append(continuity);
  const health = el(
    'section',
    { class: 'card stack', id: 'technical-health' },
    el('h2', {}, 'Stato dei servizi'),
    el(
      'p',
      { class: 'muted' },
      'I controlli verificano la raggiungibilità dei servizi. Realtime verifica il collegamento al canale; i permessi degli eventi richiedono il collaudo d’integrazione. Un controllo più vecchio di cinque minuti è da aggiornare.',
    ),
  );
  for (const component of [
    'DATABASE',
    'AUTH',
    'REALTIME',
    'STORAGE',
    'EDGE',
    'STRIPE',
    'SATISPAY',
    'PRINT',
  ]) {
    const probe = data.health.find((row) => row.component === component),
      excludedFromCore =
        (component === 'STRIPE' || component === 'SATISPAY') && !externalPaymentProvidersIncluded;
    const licensed =
      component === 'STRIPE'
        ? data.features.find((flag) => flag.name === 'STRIPE')?.licensed
        : component === 'SATISPAY'
          ? data.features.find((flag) => flag.name === 'SATISPAY_API')?.licensed
          : true;
    const current = excludedFromCore
      ? 'FUORI PERIMETRO CORE'
      : !licensed
        ? 'DISATTIVATO'
        : !probe
          ? 'NON COLLAUDATO'
          : Date.now() - Date.parse(probe.checked_at) > 300000
            ? 'DA AGGIORNARE'
            : ({
                HEALTHY: 'RAGGIUNGIBILE',
                DEGRADED: 'DEGRADATO',
                UNAVAILABLE: 'NON RAGGIUNGIBILE',
                DISABLED: 'DISATTIVATO',
                UNVERIFIED: 'NON COLLAUDATO',
              }[probe.status] ?? 'NON COLLAUDATO');
    health.append(
      el(
        'div',
        { class: 'row between' },
        el('strong', {}, component),
        status(current),
        probe
          ? el(
              'span',
              { class: 'muted' },
              `${new Date(probe.checked_at).toLocaleString('it-IT')}${probe.latency_ms === null ? '' : ` · ${probe.latency_ms} ms`}`,
            )
          : null,
      ),
    );
  }
  health.append(
    button('Esegui controlli dei servizi', async () => {
      const { error } = await client().functions.invoke('health-probe', { body: {} });
      if (error) throw safeError(error);
      toast('Controlli registrati.');
      await context.refresh?.();
    }),
  );
  view.append(
    health,
    el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Edge Functions: errori e latenza'),
      el(
        'p',
        {},
        data.metrics.latest_at
          ? `${data.metrics.requests} richieste negli ultimi 15 minuti · ${data.metrics.failures} errori server · ${data.metrics.error_percent ?? 0}%`
          : 'Nessuna misura ricevuta negli ultimi 15 minuti',
      ),
      el(
        'p',
        {},
        data.metrics.latency_p95_ms === null
          ? 'Latenza non disponibile'
          : `Latenza p95: ${data.metrics.latency_p95_ms} ms`,
      ),
    ),
  );
  const usage = el(
    'section',
    { class: 'card stack', id: 'technical-queues' },
    el('h2', {}, 'Risorse e code operative'),
  );
  const names: Record<string, string> = {
    users: 'Utenti attivi',
    venues: 'Sedi attive',
    tables: 'Tavoli attivi',
    dishes: 'Piatti attivi',
    devices: 'Dispositivi autorizzati',
    recent_devices: 'Dispositivi con attività negli ultimi 5 minuti',
    sessions: 'Sessioni staff sbloccate',
    storage_bytes: 'Storage riservato o utilizzato, byte',
    offline_pending: 'Eventi offline ricevuti da sincronizzare',
    sync_conflicts: 'Conflitti aperti',
    print_pending: 'Stampe in coda',
    print_uncertain: 'Stampe con esito da verificare',
    provider_pending: 'Operazioni provider in attesa',
    provider_manual_review: 'Provider senza esito oltre la finestra di retry',
    staff_manual_review: 'Interventi staff da verificare',
  };
  for (const [key, value] of Object.entries({ ...data.usage, ...data.queues }))
    usage.append(
      el(
        'div',
        { class: 'row between' },
        el('span', {}, names[key] ?? key),
        el('strong', {}, value),
      ),
    );
  usage.append(
    el(
      'p',
      { class: 'muted' },
      'Le code mostrate sono quelle ricevute dal server. Gli eventi ancora conservati soltanto sui dispositivi offline non possono essere conteggiati.',
    ),
  );
  usage.append(
    button(
      'Esegui conservazione configurata',
      async () => {
        const { data: result, error } = await client().functions.invoke('maintenance', {
          body: {},
        });
        if (error) throw safeError(error);
        const outcome = z.object({ enabled: z.boolean() }).passthrough().parse(result);
        dialog(
          'Conservazione dei dati',
          el(
            'p',
            {},
            outcome.enabled
              ? 'Esecuzione completata secondo i tempi configurati dall’amministratore.'
              : 'La conservazione automatica deve essere configurata e abilitata dall’amministratore.',
          ),
          el('pre', {}, JSON.stringify(outcome, null, 2)),
        );
      },
      'secondary',
    ),
  );
  view.append(usage);
  const features = el(
    'section',
    { class: 'card stack' },
    el('h2', {}, 'Licenze dell’installazione'),
  );
  for (const flag of data.features)
    features.append(
      el(
        'div',
        { class: 'row between' },
        el('span', {}, flag.name),
        status(flag.licensed ? 'ATTIVA' : 'DISATTIVA'),
        button(
          flag.licensed ? 'Disattiva licenza' : 'Attiva licenza',
          () => {
            const key = crypto.randomUUID(),
              popup = dialog(
                `Modifica ${flag.name}`,
                el(
                  'p',
                  {},
                  `La licenza sarà ${flag.licensed ? 'disattivata' : 'attivata'} per l’installazione. Il server verifica i vincoli delle sedi e del servizio.`,
                ),
              );
            popup.append(
              button('Conferma con password', async () => {
                const grant = await stepUp('FEATURE_CHANGE');
                await rpc(
                  'save_feature_license',
                  {
                    p_name: flag.name,
                    p_licensed: !flag.licensed,
                    p_version: flag.version,
                    p_grant: grant,
                    p_key: key,
                  },
                  record,
                );
                popup.close();
                await context.refresh?.();
              }),
            );
          },
          'secondary',
        ),
      ),
    );
  view.append(features);
  const limits = el('section', { class: 'card stack' }, el('h2', {}, 'Limiti delle risorse'));
  const limitNames: Record<string, string> = {
    max_users: 'Utenti',
    max_venues: 'Sedi',
    max_tables_per_venue: 'Tavoli per sede',
    max_dishes: 'Piatti',
    max_devices: 'Dispositivi',
    max_storage_bytes: 'Storage in byte',
  };
  const limitFields = Object.entries(limitNames).map(([key, label]) => {
    const control = field(label, key, 'number', String(data.limits[key]));
    control.input.required = true;
    control.input.min = '1';
    control.input.step = '1';
    limits.append(control.root);
    return { key, ...control };
  });
  limits.append(
    button('Salva limiti con password', async () => {
      if (limitFields.some((control) => !control.input.reportValidity())) return;
      const grant = await stepUp('FEATURE_CHANGE');
      await rpc(
        'configure_system_limits',
        {
          p_limits: Object.fromEntries(
            limitFields.map((control) => [control.key, Number(control.input.value)]),
          ),
          p_grant: grant,
        },
        z.null(),
      );
      toast('Limiti aggiornati.');
      await context.refresh?.();
    }),
  );
  view.append(limits);
  const security = el('section', { class: 'card stack' }, el('h2', {}, 'Autenticazione'));
  const adminMfa = el('input', { type: 'checkbox' }),
    cashierMfa = el('input', { type: 'checkbox' });
  adminMfa.checked = data.settings.admin_mfa_required === true;
  cashierMfa.checked = data.settings.cashier_mfa_required === true;
  const full = field(
      'Durata autenticazione completa, minuti',
      'full_auth',
      'number',
      String(data.settings.full_auth_minutes),
    ),
    offline = field(
      'Validità autorizzazione offline, minuti',
      'offline_ttl',
      'number',
      String(data.settings.offline_ttl_minutes),
    );
  full.input.min = '30';
  full.input.max = '720';
  offline.input.min = '5';
  offline.input.max = '120';
  const securityKey = crypto.randomUUID();
  security.append(
    el('label', {}, adminMfa, 'MFA obbligatoria per Admin'),
    el('label', {}, cashierMfa, 'MFA obbligatoria per Cashier'),
    full.root,
    offline.root,
    el(
      'p',
      { class: 'muted' },
      'La MFA del Super Admin è sempre obbligatoria. Questa modifica revoca tutte le autorizzazioni offline esistenti.',
    ),
    button('Salva autenticazione con password', async () => {
      if (!full.input.reportValidity() || !offline.input.reportValidity()) return;
      const grant = await stepUp('FEATURE_CHANGE');
      await rpc(
        'configure_authentication',
        {
          p_version: data.settings.version,
          p_admin_mfa: adminMfa.checked,
          p_cashier_mfa: cashierMfa.checked,
          p_full_auth: Number(full.input.value),
          p_offline_ttl: Number(offline.input.value),
          p_grant: grant,
          p_key: securityKey,
        },
        record,
      );
      toast('Autenticazione aggiornata.');
      await context.refresh?.();
    }),
  );
  view.append(security);
  const lifecycle = el(
    'section',
    { class: 'card stack' },
    el('h2', {}, String(data.profile.name)),
    status(String(data.profile.status)),
  );
  if (['ACTIVE', 'SUSPENDED'].includes(String(data.profile.status)))
    lifecycle.append(
      button(
        data.profile.status === 'ACTIVE' ? 'Sospendi installazione' : 'Riattiva installazione',
        () => {
          const reason = field('Motivo', 'reason');
          reason.input.required = true;
          reason.input.minLength = 8;
          reason.input.maxLength = 2000;
          const popup = dialog(
              data.profile.status === 'ACTIVE'
                ? 'Sospensione del servizio'
                : 'Riattivazione del servizio',
              el(
                'p',
                {},
                'La sospensione impedisce gli accessi operativi e le nuove richieste. L’accesso tecnico resta disponibile.',
              ),
              reason.root,
            ),
            key = crypto.randomUUID();
          popup.append(
            button('Conferma con password', async () => {
              if (!reason.input.reportValidity()) return;
              const grant = await stepUp('INSTALLATION_STATUS');
              await rpc(
                'change_installation_status',
                {
                  p_status: data.profile.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
                  p_version: data.profile.version,
                  p_reason: reason.input.value,
                  p_grant: grant,
                  p_key: key,
                },
                record,
              );
              popup.close();
              await context.refresh?.();
            }),
          );
        },
        'secondary',
      ),
    );
  view.append(lifecycle);
  const incidents = el('section', { class: 'card stack' }, el('h2', {}, 'Incidenti aperti'));
  function editIncident(existing?: Record<string, unknown>): void {
    const title = field('Titolo', 'title', 'text', String(existing?.title ?? '')),
      impact = field('Impatto', 'impact', 'text', String(existing?.impact ?? '')),
      detail = field('Aggiornamento o postmortem', 'detail');
    title.input.required = true;
    title.input.minLength = 3;
    title.input.maxLength = 160;
    impact.input.required = true;
    detail.input.required = true;
    const component = el(
      'select',
      { 'aria-label': 'Componente' },
      ...[
        'DATABASE',
        'AUTH',
        'REALTIME',
        'STORAGE',
        'EDGE',
        'PAYMENTS',
        'PRINT',
        'OFFLINE',
        'BACKUP',
        'APPLICATION',
      ].map((value) => el('option', { value }, value)),
    );
    component.value = String(existing?.component ?? 'APPLICATION');
    const severity = el(
      'select',
      { 'aria-label': 'Gravità' },
      ...['INFO', 'WARNING', 'DEGRADED', 'INCIDENT', 'CRITICAL'].map((value) =>
        el('option', { value }, value),
      ),
    );
    severity.value = String(existing?.severity ?? 'WARNING');
    const state = el(
      'select',
      { 'aria-label': 'Stato incidente' },
      ...(existing ? ['OPEN', 'INVESTIGATING', 'MITIGATED', 'RESOLVED'] : ['OPEN']).map((value) =>
        el('option', { value }, value),
      ),
    );
    state.value = String(existing?.status ?? 'OPEN');
    const popup = dialog(
        existing ? 'Aggiorna incidente' : 'Apri incidente',
        title.root,
        impact.root,
        el('label', {}, 'Componente', component),
        el('label', {}, 'Gravità', severity),
        el('label', {}, 'Stato', state),
        detail.root,
      ),
      key = crypto.randomUUID();
    popup.append(
      button('Registra aggiornamento', async () => {
        if ([title, impact, detail].some((control) => !control.input.reportValidity())) return;
        await rpc(
          'update_incident',
          {
            p_id: existing?.id ?? null,
            p_venue: existing?.venue_id ?? null,
            p_component: component.value,
            p_severity: severity.value,
            p_title: title.input.value,
            p_impact: impact.input.value,
            p_status: state.value,
            p_detail: detail.input.value,
            p_version: existing?.version ?? null,
            p_key: key,
          },
          record,
        );
        popup.close();
        await context.refresh?.();
      }),
    );
    if (existing)
      popup.append(
        button(
          'Cronologia',
          async () => {
            const events = await readRows(
              'incident_events',
              z.object({ action: z.string(), detail: z.string(), created_at: z.string() }),
              undefined,
              { incident_id: String(existing.id) },
            );
            dialog(
              'Cronologia incidente',
              ...events
                .sort((a, b) => a.created_at.localeCompare(b.created_at))
                .map((event) =>
                  el(
                    'article',
                    { class: 'card' },
                    el(
                      'strong',
                      {},
                      `${new Date(event.created_at).toLocaleString('it-IT')} · ${event.action}`,
                    ),
                    el('p', {}, event.detail),
                  ),
                ),
            );
          },
          'secondary',
        ),
      );
  }
  incidents.append(button('Apri incidente', () => editIncident(), 'secondary'));
  for (const incident of data.incidents)
    incidents.append(
      el(
        'article',
        { class: 'card row between' },
        el('strong', {}, String(incident.title)),
        ...(incident.automation_key ? [status('AUTO')] : []),
        status(String(incident.severity)),
        status(String(incident.status)),
        button('Gestisci incidente', () => editIncident(incident), 'secondary'),
      ),
    );
  if (!data.incidents.length) incidents.append(el('p', {}, 'Nessun incidente aperto registrato.'));
  const auditArchiveHealth = el(
    'section',
    { class: 'card stack', id: 'audit-archive-health' },
    el('h2', {}, 'Archivio Audit e autenticazione'),
  );
  const auditArchiveSummary = el(
    'div',
    { class: 'stack' },
    el('p', {}, 'Verifica archivio in corso…'),
  );
  auditArchiveHealth.append(auditArchiveSummary);
  view.append(auditArchiveHealth);
  const archiveSchema = z.object({
    last_batch: z.number(),
    archived_rows: z.number(),
    remaining_rows: z.number(),
    latest_verification: z
      .object({
        result: z.string(),
        checked_at: z.string(),
        checked_batches: z.number(),
        checked_rows: z.number(),
      })
      .nullable(),
  });
  const authSchema = z.object({
    status: z.string(),
    native_rows: z.number(),
    login_attempts: z.number(),
    mfa_verification_attempts: z.number(),
    login_failures_certified: z.boolean(),
    mfa_failures_certified: z.boolean(),
  });
  // Fail closed for partial deployments; never block the technical dashboard.
  void Promise.allSettled([
    rpc('get_audit_archive_health', {}, archiveSchema),
    rpc('get_auth_audit_readiness', {}, authSchema),
  ]).then(([archive, auth]) => {
    auditArchiveSummary.replaceChildren();
    if (archive.status === 'fulfilled') {
      const proof = archive.value.latest_verification;
      auditArchiveSummary.append(
        el(
          'p',
          {},
          'Archivio cifrato: ' +
            String(archive.value.archived_rows) +
            ' eventi in ' +
            String(archive.value.last_batch) +
            ' blocchi; da archiviare: ' +
            String(archive.value.remaining_rows) +
            '.',
        ),
        el(
          'p',
          {},
          'Ultimo test di recupero: ' +
            (proof
              ? proof.result +
                ' · ' +
                proof.checked_rows +
                ' righe verificate · ' +
                new Date(proof.checked_at).toLocaleString('it-IT')
              : 'NON VERIFICATO'),
        ),
      );
    } else {
      auditArchiveSummary.append(el('p', { class: 'muted' }, 'Archivio: stato non verificabile.'));
    }
    if (auth.status === 'fulfilled') {
      auditArchiveSummary.append(
        el(
          'p',
          {},
          'Audit nativo Supabase Auth: ' +
            auth.value.status +
            ' · eventi nel database: ' +
            auth.value.native_rows +
            ' · tentativi login: ' +
            auth.value.login_attempts +
            ' · tentativi MFA: ' +
            auth.value.mfa_verification_attempts +
            '.',
        ),
        el(
          'p',
          { class: 'muted' },
          'Gli eventi Auth senza esito attendibile non sono classificati come login o MFA falliti.',
        ),
      );
    } else {
      auditArchiveSummary.append(
        el('p', { class: 'muted' }, 'Audit Auth: stato non verificabile.'),
      );
    }
    auditArchiveSummary.append(
      el(
        'p',
        { class: 'muted' },
        'Nessuna retention automatica dell’audit è attiva. L’archiviazione cifrata su due progetti non equivale a conservazione WORM certificata.',
      ),
    );
  });
  view.append(incidents);
  return view;
}
