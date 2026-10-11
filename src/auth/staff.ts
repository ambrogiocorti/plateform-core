import { clearOffline } from '../offline/store';
import { z } from 'zod';
import { client, rpc, safeError } from '../api/client';
import { environment } from '../config/environment';
import { staffProfileSchema } from '../types/domain';
import type { StaffProfile } from '../types/domain';
import { el, button, field, showError } from '../components/dom';

const requirementsSchema = z.object({
  role: z.string(),
  display_name: z.string(),
  active: z.boolean(),
  mfa_required: z.boolean(),
  installation_active: z.boolean(),
  setup_required: z.boolean(),
  session_unlocked: z.boolean(),
  pin_enabled: z.boolean(),
  password_required: z.boolean(),
  full_auth_expires_at: z.string().nullable(),
  retry_after_seconds: z.number(),
});
export type Requirements = z.infer<typeof requirementsSchema>;

export async function requirements(): Promise<Requirements | null> {
  return rpc('get_auth_requirements', {}, requirementsSchema.nullable());
}

export async function activeProfile(): Promise<StaffProfile | null> {
  const {
    data: { session },
  } = await client().auth.getSession();
  if (!session) return null;
  const assistance = sessionStorage.getItem('plateform-impersonation');
  if (assistance) {
    try {
      return (
        await rpc(
          'get_impersonation_context',
          { p_id: assistance },
          z.object({ profile: staffProfileSchema }),
        )
      ).profile;
    } catch {
      sessionStorage.removeItem('plateform-impersonation');
      location.reload();
      return null;
    }
  }
  const { data, error } = await client()
    .from('staff_profiles')
    .select('id,display_name,role,scope,active,version')
    .eq('id', session.user.id)
    .maybeSingle();
  if (error) throw safeError(error);
  return data ? staffProfileSchema.parse(data) : null;
}

export async function signOut(): Promise<void> {
  // Best effort: record and revoke the application session before clearing GoTrue locally.
  // This may already be revoked after password/access changes, so failure must not trap the user.
  await rpc('end_staff_session', {}, z.null()).catch(() => undefined);
  const { error } = await client().auth.signOut({ scope: 'local' });
  if (error) throw safeError(error);
  await clearOffline();
  sessionStorage.clear();
}

export async function finishLogin(): Promise<void> {
  const {
    data: { session },
  } = await client().auth.getSession();
  if (!session) throw new Error('FULL_AUTH_REQUIRED');
  const storageKey = `plateform-device:${session.user.id}`;
  const saved = localStorage.getItem(storageKey);
  const registrationSchema = z.object({
    id: z.uuid().nullable(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  });
  let registration: z.infer<typeof registrationSchema> | undefined;
  try {
    registration = saved ? registrationSchema.parse(JSON.parse(saved)) : undefined;
  } catch {
    /* Discard malformed local registration, never trust it for authorization. */
  }
  registration ??= {
    id: null,
    token: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', ''),
  };
  localStorage.setItem(storageKey, JSON.stringify(registration));
  const result = await rpc(
    'complete_staff_login',
    {
      p_device_name: `${navigator.platform || 'Browser'} · ${new Date().toLocaleDateString('it-IT')}`,
      p_platform: navigator.platform || 'Browser',
      p_app_version: environment().releaseVersion,
      p_device: registration.id,
      p_device_token: registration.token,
    },
    z.object({ device_id: z.uuid().nullable(), expires_at: z.string() }),
  );
  localStorage.setItem(storageKey, JSON.stringify({ ...registration, id: result.device_id }));
}

export function loginPage(onComplete: () => Promise<void>): HTMLElement {
  const identity = field('Identificativo staff', 'email', 'email');
  identity.input.required = true;
  identity.input.autocomplete = 'username';
  const password = field('Password', 'password', 'password');
  password.input.required = true;
  password.input.autocomplete = 'current-password';
  const feedback = el('p', { role: 'alert', class: 'muted' });
  const submit = el('button', { type: 'submit', class: 'button primary' }, 'Accedi al servizio');
  const form = el(
    'form',
    { class: 'login-form' },
    el('p', { class: 'eyebrow' }, 'Area riservata'),
    el('h2', {}, 'Bentornato.'),
    el('p', { class: 'muted' }, 'Il tuo spazio, prima e durante il servizio.'),
    identity.root,
    password.root,
    feedback,
    submit,
    el(
      'p',
      { class: 'login-footnote' },
      'Hai dimenticato la password? Contatta l’amministratore del ristorante per il recupero del tuo account.',
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    feedback.textContent = '';
    void (async () => {
      // GoTrue checks the password in the trusted Edge gateway and writes
      // AUTH_LOGIN_FAILED only for a genuine provider rejection.
      const { data: verified, error } = await client().functions.invoke('auth-audit-gateway', {
        body: {
          action: 'PASSWORD_LOGIN',
          identifier: identity.input.value.trim(),
          password: password.input.value,
        },
      });
      password.input.value = '';
      if (error) throw safeError(error);
      const login = z.discriminatedUnion('status', [
        z.object({ status: z.literal('REJECTED') }),
        z.object({
          status: z.literal('ACCEPTED'),
          access_token: z.string().min(1),
          refresh_token: z.string().min(1),
        }),
      ]).parse(verified);
      if (login.status === 'REJECTED') throw new Error('Credenziali non valide.');
      const { error: sessionError } = await client().auth.setSession({
        access_token: login.access_token,
        refresh_token: login.refresh_token,
      });
      if (sessionError) throw safeError(sessionError);
      const info = await requirements();
      if (
        !info ||
        !info.active ||
        (!info.installation_active && !info.setup_required && info.role !== 'SUPER_ADMIN')
      )
        throw new Error('Accesso non disponibile.');
      const { data: level, error: levelError } =
        await client().auth.mfa.getAuthenticatorAssuranceLevel();
      if (levelError) throw safeError(levelError);
      if (info.mfa_required && level?.currentLevel !== 'aal2') {
        await showMfa(form, async () => {
          await finishLogin();
          await onComplete();
        });
      } else {
        await finishLogin();
        await onComplete();
      }
    })()
      .catch((error: unknown) => {
        feedback.textContent =
          error instanceof Error &&
          ['Credenziali non valide.', 'Accesso non disponibile.'].includes(error.message)
            ? error.message
            : safeError(error).message;
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
  return el(
    'main',
    { id: 'main', class: 'login-layout' },
    el(
      'section',
      { class: 'login-story' },
      el('a', { href: '/', class: 'brand' }, 'Plateform'),
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, 'People. Food. Service. Together.'),
        el('h1', {}, 'Ogni dettaglio.', el('br'), el('span', {}, 'Un grande servizio.')),
      ),
      el('footer', { class: 'muted' }, 'Restaurant operating system'),
    ),
    el('section', { class: 'login-panel' }, form),
  );
}

async function showMfa(container: HTMLElement, onVerified: () => Promise<void>): Promise<void> {
  const { data, error } = await client().auth.mfa.listFactors();
  if (error) throw safeError(error);
  let factorId = data.totp.find((factor) => factor.status === 'verified')?.id;
  const instructions = el('div', { class: 'stack' });
  if (!factorId) {
    const { data: enrollment, error: enrollmentError } = await client().auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Plateform',
    });
    if (enrollmentError) throw safeError(enrollmentError);
    factorId = enrollment.id;
    const qr = el('img', {
      alt: 'QR per configurare l’app di autenticazione',
      src: enrollment.totp.qr_code,
    });
    instructions.append(
      el(
        'p',
        {},
        'Configura l’app di autenticazione con questo QR, poi inserisci il codice a sei cifre.',
      ),
      qr,
      el(
        'details',
        {},
        el('summary', {}, 'Inserimento manuale'),
        el('code', {}, enrollment.totp.secret),
      ),
    );
  }
  const code = field('Codice di autenticazione', 'totp', 'text');
  code.input.inputMode = 'numeric';
  code.input.pattern = '[0-9]{6}';
  code.input.maxLength = 6;
  code.input.autocomplete = 'one-time-code';
  code.input.required = true;
  const verify = button('Verifica e accedi', async () => {
    if (!code.input.reportValidity()) return;
    const { data: verified, error } = await client().functions.invoke('auth-audit-gateway', {
      body: { action: 'MFA_VERIFY', factor_id: factorId, code: code.input.value },
    });
    code.input.value = '';
    if (error) throw safeError(error);
    const result = z.discriminatedUnion('status', [
      z.object({ status: z.literal('REJECTED') }),
      z.object({
        status: z.literal('ACCEPTED'),
        access_token: z.string().min(1),
        refresh_token: z.string().min(1),
      }),
    ]).parse(verified);
    if (result.status === 'REJECTED') {
      showError(new Error('MFA_REQUIRED'));
      return;
    }
    const { error: sessionError } = await client().auth.setSession({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    });
    if (sessionError) throw safeError(sessionError);
    await onVerified();
  });
  container.replaceChildren(
    el('p', { class: 'eyebrow' }, 'Protezione account'),
    el('h2', {}, 'Verifica la tua identità.'),
    instructions,
    code.root,
    verify,
  );
  code.input.focus();
}
