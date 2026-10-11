import { z } from 'zod';
import { client, readRows, rpc } from '../api/client';
import { button, dialog, el, field, status, toast } from '../components/dom';
import { stepUp } from '../auth/step-up';
import type { StaffContext } from './staff-context';
import { command } from './staff-context';

const managedStaffSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  role: z.enum([
    'SUPER_ADMIN',
    'ADMIN',
    'HOST',
    'CASHIER',
    'KITCHEN_ADMIN',
    'KITCHEN_STAFF',
    'PASS',
    'WAITER',
    'CUSTOMER',
    'SYSTEM',
  ]),
  scope: z.enum(['CHAIN', 'VENUE']),
  active: z.boolean(),
  version: z.number(),
  can_manage: z.boolean(),
  venue_ids: z.array(z.uuid()),
});
const managementWorkspaceSchema = z.object({
  identity_domain: z.string().nullable(),
  staff: z.array(managedStaffSchema),
});

function roleOptions(context: StaffContext): string[] {
  return context.profile.role === 'SUPER_ADMIN'
    ? ['ADMIN']
    : ['HOST', 'CASHIER', 'KITCHEN_ADMIN', 'KITCHEN_STAFF', 'PASS', 'WAITER'];
}

function accessScopeEditor(
  context: StaffContext,
  initialScope: 'CHAIN' | 'VENUE',
  initialVenues: string[],
): { scope: HTMLSelectElement; venueIds: Set<string>; venueFields: HTMLElement; sync: () => void } {
  const scope = el(
    'select',
    { 'aria-label': 'Ambito' },
    el('option', { value: 'VENUE' }, 'Sedi assegnate'),
    context.profile.scope === 'CHAIN' ? el('option', { value: 'CHAIN' }, 'Intera catena') : null,
  );
  scope.value = initialScope;
  const venueIds = new Set(initialVenues);
  const venueFields = el(
    'fieldset',
    {},
    el('legend', {}, 'Sedi autorizzate'),
    ...context.venues.map((venue) => {
      const input = el('input', { type: 'checkbox', value: venue.id });
      input.checked = venueIds.has(venue.id);
      input.addEventListener('change', () => {
        if (input.checked) venueIds.add(venue.id);
        else venueIds.delete(venue.id);
      });
      return el('label', { class: 'checkbox-line' }, input, venue.name);
    }),
  );
  const sync = () => {
    venueFields.hidden = scope.value === 'CHAIN';
  };
  scope.addEventListener('change', sync);
  sync();
  return { scope, venueIds, venueFields, sync };
}

export async function staffManagementPage(context: StaffContext): Promise<HTMLElement> {
  const workspace = await rpc('get_staff_management_workspace', {}, managementWorkspaceSchema);
  const staff = workspace.staff;
  const view = el(
    'div',
    { class: 'stack' },
    el(
      'div',
      { class: 'row between' },
      el(
        'div',
        {},
        el('h2', {}, 'La squadra'),
        workspace.identity_domain
          ? el('p', { class: 'muted' }, `Dominio identificativi: ${workspace.identity_domain}`)
          : null,
      ),
      button('Aggiungi utente', () => {
        const name = field('Nome e cognome', 'name');
        const identifier = field('Identificativo staff', 'email', 'email');
        const password = field('Password iniziale', 'password', 'password');
        password.input.minLength = 12;
        password.input.autocomplete = 'new-password';
        for (const input of [name, identifier, password]) input.input.required = true;
        const roles = roleOptions(context);
        const role = el(
          'select',
          { 'aria-label': 'Ruolo' },
          ...roles.map((value) => el('option', { value }, value.replaceAll('_', ' '))),
        );
        const access = accessScopeEditor(
          context,
          context.profile.scope === 'CHAIN' && context.profile.role === 'SUPER_ADMIN'
            ? 'CHAIN'
            : 'VENUE',
          context.venue ? [context.venue.id] : [],
        );
        const { scope, venueIds, venueFields } = access;
        let suggestionRevision = 0;
        const suggestIdentifier = async () => {
          const current = ++suggestionRevision;
          const candidateName = name.input.value.trim();
          if (!candidateName || identifier.input.value.trim()) return;
          const suggested = await rpc(
            'suggest_staff_identifier',
            { p_name: candidateName },
            z.string(),
          );
          if (current === suggestionRevision && !identifier.input.value.trim())
            identifier.input.value = suggested;
        };
        name.input.addEventListener('blur', () => void suggestIdentifier().catch(() => undefined));
        const editor = dialog(
          'Nuovo utente staff',
          name.root,
          identifier.root,
          button(
            'Suggerisci identificativo',
            async () => {
              identifier.input.value = '';
              await suggestIdentifier();
            },
            'secondary',
          ),
          password.root,
          el('label', {}, 'Ruolo', role),
          el('label', {}, 'Ambito', scope),
          venueFields,
        );
        const commandKey = crypto.randomUUID();
        editor.append(
          button('Crea utente', async () => {
            if ([name, identifier, password].some((input) => !input.input.reportValidity())) return;
            const staffIdentifier = identifier.input.value.trim().toLowerCase();
            const identityDomain = workspace.identity_domain?.trim().toLowerCase();
            if (identityDomain && staffIdentifier.split('@').at(-1) !== identityDomain) {
              toast(
                `L'identificativo staff deve terminare con @${identityDomain}. Usa “Suggerisci identificativo” per generarne uno valido.`,
                true,
              );
              return;
            }
            if (scope.value === 'VENUE' && venueIds.size === 0) {
              toast('Assegna almeno una sede allo staff con ambito sede.', true);
              return;
            }
            const grant = await stepUp(
              role.value === 'ADMIN' ? 'PRIVILEGED_STAFF' : 'STAFF_CHANGE',
            );
            const secret = password.input.value;
            password.input.value = '';
            const { data, error } = await client().functions.invoke('staff-admin', {
              body: {
                action: 'CREATE',
                idempotency_key: commandKey,
                display_name: name.input.value.trim(),
                identifier: staffIdentifier,
                password: secret,
                role: role.value,
                scope: scope.value,
                venue_ids: [...venueIds],
                grant_id: grant,
              },
            });
            if (error) throw error;
            z.object({ id: z.uuid() }).parse(data);
            editor.close();
            toast('Utente creato.');
            context.navigate('/staff');
          }),
        );
      }),
    ),
  );
  for (const user of staff) {
    const card = el(
      'article',
      { class: 'card row between' },
      el(
        'div',
        {},
        el('h3', {}, user.display_name),
        status(user.role),
        status(user.scope),
        status(user.active ? 'ATTIVO' : 'DISATTIVATO'),
        user.scope === 'VENUE'
          ? el(
              'p',
              { class: 'muted' },
              user.venue_ids
                .map((id) => context.venues.find((venue) => venue.id === id)?.name ?? id)
                .join(' · ') || 'Nessuna sede',
            )
          : null,
      ),
    );
    if (context.profile.role === 'SUPER_ADMIN' && user.id !== context.profile.id && user.active)
      card.append(
        button(
          'Assistenza in sola lettura',
          () => {
            const reason = field('Motivo assistenza', 'reason');
            reason.input.required = true;
            reason.input.minLength = 8;
            const popup = dialog('Accedi in assistenza', reason.root);
            const key = crypto.randomUUID();
            popup.append(
              button('Conferma identità e avvia', async () => {
                if (!reason.input.reportValidity()) return;
                const grant = await stepUp('IMPERSONATION', user.id);
                const result = await rpc(
                  'begin_impersonation',
                  { p_subject: user.id, p_reason: reason.input.value, p_grant: grant, p_key: key },
                  z.object({ id: z.uuid() }),
                );
                sessionStorage.setItem('plateform-impersonation', result.id);
                location.reload();
              }),
            );
          },
          'secondary',
        ),
      );
    if (user.id !== context.profile.id && user.can_manage)
      card.append(
        button(
          'Ruolo e sedi',
          () => {
            const name = field('Nome e cognome', 'staff-name', 'text', user.display_name);
            name.input.required = true;
            name.input.maxLength = 160;
            const role = el(
              'select',
              { 'aria-label': 'Ruolo' },
              ...roleOptions(context).map((value) =>
                el('option', { value }, value.replaceAll('_', ' ')),
              ),
            );
            role.value = user.role;
            const access = accessScopeEditor(context, user.scope, user.venue_ids);
            const reason = field('Motivo della modifica', 'access-reason');
            reason.input.required = true;
            reason.input.minLength = 8;
            reason.input.maxLength = 2000;
            const popup = dialog(
              `Accesso · ${user.display_name}`,
              name.root,
              el('label', {}, 'Ruolo', role),
              el('label', {}, 'Ambito', access.scope),
              access.venueFields,
              reason.root,
            );
            const key = crypto.randomUUID();
            popup.append(
              button('Salva ruolo e sedi', async () => {
                if (!name.input.reportValidity() || !reason.input.reportValidity()) return;
                if (access.scope.value === 'VENUE' && access.venueIds.size === 0) {
                  toast('Assegna almeno una sede allo staff con ambito sede.', true);
                  return;
                }
                const grant = await stepUp(
                  context.profile.role === 'SUPER_ADMIN' ? 'PRIVILEGED_STAFF' : 'STAFF_CHANGE',
                  user.id,
                );
                await rpc(
                  'update_staff_access',
                  {
                    p_user: user.id,
                    p_name: name.input.value,
                    p_role: role.value,
                    p_scope: access.scope.value,
                    p_venues: [...access.venueIds],
                    p_version: user.version,
                    p_reason: reason.input.value,
                    p_grant: grant,
                    p_key: key,
                  },
                  z.object({ id: z.uuid(), version: z.number() }),
                );
                popup.close();
                toast('Ruolo e sedi aggiornati. Le sessioni non più valide sono state revocate.');
                await context.refresh?.();
              }),
            );
          },
          'secondary',
        ),
        button(
          'Gestisci accesso',
          () => {
            const password = field('Nuova password', 'new-password', 'password');
            password.input.minLength = 12;
            password.input.required = true;
            const reason = field('Motivo e verifica dell’identità', 'reason');
            reason.input.required = true;
            reason.input.minLength = 8;
            const verified = el('input', { type: 'checkbox', required: '' });
            const editor = dialog(
              user.display_name,
              password.root,
              reason.root,
              el(
                'label',
                {},
                verified,
                'Ho verificato l’identità del collega e il motivo del recupero.',
              ),
            );
            const resetKey = crypto.randomUUID(),
              disableKey = crypto.randomUUID(),
              reactivateKey = crypto.randomUUID(),
              mfaKey = crypto.randomUUID();
            editor.append(
              button(
                'Reimposta PIN',
                async () => {
                  if (![reason.input, verified].every((input) => input.reportValidity())) return;
                  const grant = await stepUp(
                    context.profile.role === 'SUPER_ADMIN' ? 'PRIVILEGED_STAFF' : 'STAFF_CHANGE',
                    user.id,
                  );
                  await rpc('reset_staff_pin', { p_user: user.id, p_grant: grant }, z.null());
                  editor.close();
                  toast('PIN rimosso. L’utente deve accedere con password e impostarne uno nuovo.');
                },
                'secondary',
              ),
              button('Reimposta password', async () => {
                if (
                  ![password.input, reason.input, verified].every((input) => input.reportValidity())
                )
                  return;
                const grant = await stepUp(
                  context.profile.role === 'SUPER_ADMIN' ? 'PRIVILEGED_STAFF' : 'STAFF_CHANGE',
                  user.id,
                );
                const secret = password.input.value;
                password.input.value = '';
                const { error } = await client().functions.invoke('staff-admin', {
                  body: {
                    action: 'RESET_PASSWORD',
                    idempotency_key: resetKey,
                    reason: reason.input.value,
                    identity_verified: true,
                    user_id: user.id,
                    password: secret,
                    grant_id: grant,
                  },
                });
                if (error) throw error;
                editor.close();
                toast('Password reimpostata e sessioni precedenti revocate.');
              }),
              button(
                'Reimposta MFA',
                async () => {
                  if (![reason.input, verified].every((input) => input.reportValidity())) return;
                  const grant = await stepUp(
                    context.profile.role === 'SUPER_ADMIN' ? 'PRIVILEGED_STAFF' : 'STAFF_CHANGE',
                    user.id,
                  );
                  const { error } = await client().functions.invoke('staff-admin', {
                    body: {
                      action: 'RESET_MFA',
                      user_id: user.id,
                      idempotency_key: mfaKey,
                      grant_id: grant,
                      reason: reason.input.value,
                      identity_verified: true,
                    },
                  });
                  if (error) throw error;
                  editor.close();
                  toast(
                    'Fattori MFA rimossi e dispositivi revocati. È richiesto un nuovo accesso.',
                  );
                },
                'secondary',
              ),
              user.active
                ? button(
                    'Disattiva utente',
                    async () => {
                      if (![reason.input, verified].every((input) => input.reportValidity()))
                        return;
                      const grant = await stepUp(
                        context.profile.role === 'SUPER_ADMIN'
                          ? 'PRIVILEGED_STAFF'
                          : 'STAFF_CHANGE',
                        user.id,
                      );
                      const { error } = await client().functions.invoke('staff-admin', {
                        body: {
                          action: 'DISABLE',
                          user_id: user.id,
                          grant_id: grant,
                          idempotency_key: disableKey,
                          reason: reason.input.value,
                          identity_verified: true,
                        },
                      });
                      if (error) throw error;
                      editor.close();
                      await context.refresh?.();
                    },
                    'danger',
                  )
                : button('Riattiva utente', async () => {
                    if (![reason.input, verified].every((input) => input.reportValidity())) return;
                    const grant = await stepUp(
                      context.profile.role === 'SUPER_ADMIN' ? 'PRIVILEGED_STAFF' : 'STAFF_CHANGE',
                      user.id,
                    );
                    const { error } = await client().functions.invoke('staff-admin', {
                      body: {
                        action: 'REACTIVATE',
                        user_id: user.id,
                        grant_id: grant,
                        idempotency_key: reactivateKey,
                        reason: reason.input.value,
                        identity_verified: true,
                      },
                    });
                    if (error) throw error;
                    editor.close();
                    toast('Utente riattivato.');
                    await context.refresh?.();
                  }),
            );
          },
          'secondary',
        ),
      );
    if (
      context.profile.role === 'ADMIN' &&
      context.venue &&
      ['WAITER', 'CASHIER', 'KITCHEN_STAFF'].includes(user.role)
    )
      card.append(
        button(
          'Assegna al servizio',
          async () => {
            const source =
              user.role === 'WAITER'
                ? 'tables'
                : user.role === 'CASHIER'
                  ? 'cash_registers'
                  : 'stations';
            const resources = await readRows(
              source,
              z.object({ id: z.uuid(), name: z.string() }),
              context.venue?.id,
            );
            const resource = el(
              'select',
              { 'aria-label': 'Assegnazione' },
              ...resources.map((entry) => el('option', { value: entry.id }, entry.name)),
            );
            const editor = dialog(
              'Assegnazione operativa',
              el('label', {}, 'Postazione o tavolo', resource),
            );
            const mode = el(
              'select',
              { 'aria-label': 'Modalità cameriere' },
              el('option', { value: 'TABLE' }, 'Responsabile tavolo'),
              el('option', { value: 'ZONE' }, 'Responsabile zona'),
              el('option', { value: 'RUNNER' }, 'Runner: consegne'),
            );
            const zones =
              user.role === 'WAITER'
                ? await readRows(
                    'zones',
                    z.object({ id: z.uuid(), name: z.string() }),
                    context.venue?.id,
                    { active: 'true' },
                  )
                : [];
            if (user.role === 'WAITER') {
              editor.append(el('label', {}, 'Modalità operativa', mode));
              const setOptions = () => {
                resource.hidden = mode.value === 'RUNNER';
                resource.replaceChildren(
                  ...(mode.value === 'ZONE' ? zones : resources).map((entry) =>
                    el('option', { value: entry.id }, entry.name),
                  ),
                );
              };
              mode.addEventListener('change', setOptions);
              setOptions();
            }
            editor.append(
              button('Assegna', async () => {
                if (user.role === 'WAITER')
                  await rpc(
                    'assign_waiter',
                    {
                      p_venue: context.venue?.id,
                      p_waiter: user.id,
                      p_mode: mode.value,
                      p_table: mode.value === 'TABLE' ? resource.value : null,
                      p_zone: mode.value === 'ZONE' ? resource.value : null,
                    },
                    z.uuid(),
                  );
                else
                  await command('assign_operational_staff', {
                    p_venue: context.venue?.id,
                    p_user: user.id,
                    p_kind: user.role === 'CASHIER' ? 'REGISTER' : 'STATION',
                    p_resource: resource.value,
                    p_active: true,
                  });
                editor.close();
                toast('Assegnazione salvata.');
              }),
            );
          },
          'secondary',
        ),
      );
    view.append(card);
  }
  const jobs = await readRows(
    'staff_admin_jobs',
    z.object({ id: z.uuid(), target_user_id: z.uuid(), action: z.string(), status: z.string() }),
  );
  for (const job of jobs.filter((j) => j.status !== 'COMPLETED'))
    view.append(
      el(
        'section',
        { class: 'card row' },
        el('strong', {}, `Operazione da riprendere: ${job.action}`),
        status(job.status),
        button(
          'Riprendi',
          () => {
            const password = field(
              'Password (solo se la creazione o il reset non sono ancora avvenuti)',
              'recovery-password',
              'password',
            );
            password.input.minLength = 12;
            const popup = dialog('Recupero operazione staff', password.root);
            popup.append(
              button('Verifica identità e riprendi', async () => {
                const grant = await stepUp(
                  context.profile.role === 'SUPER_ADMIN' ? 'PRIVILEGED_STAFF' : 'STAFF_CHANGE',
                  job.action === 'CREATE' ? null : job.target_user_id,
                );
                const secret = password.input.value;
                password.input.value = '';
                const { error } = await client().functions.invoke('staff-admin', {
                  body: {
                    action: 'RESUME',
                    job_id: job.id,
                    grant_id: grant,
                    ...(secret ? { password: secret } : {}),
                  },
                });
                if (error) throw error;
                popup.close();
                await context.refresh?.();
              }),
            );
          },
          'secondary',
        ),
      ),
    );
  return view;
}
