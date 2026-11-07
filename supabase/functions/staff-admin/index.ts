import { z } from 'npm:zod@4.6.7';
import { endpoint, rateKey, rateLimit, serverClient, userClient } from '../_shared/http.ts';
import { staffCommandError, staffPasswordFingerprint } from '../_shared/staff-command.ts';

const access = z.object({ grant_id: z.uuid(), idempotency_key: z.uuid() });
const createSchema = access
  .extend({
    action: z.literal('CREATE'),
    display_name: z.string().trim().min(1).max(160),
    identifier: z.email(),
    password: z.string().min(12).max(1024),
    role: z.enum(['ADMIN', 'HOST', 'CASHIER', 'KITCHEN_ADMIN', 'KITCHEN_STAFF', 'PASS', 'WAITER']),
    scope: z.enum(['CHAIN', 'VENUE']),
    venue_ids: z.array(z.uuid()).max(100),
  })
  .strict();
const resetSchema = access
  .extend({
    action: z.literal('RESET_PASSWORD'),
    user_id: z.uuid(),
    password: z.string().min(12).max(1024),
    reason: z.string().min(8).max(2000),
    identity_verified: z.literal(true),
  })
  .strict();
const recoverySchema = access
  .extend({
    action: z.enum(['DISABLE', 'RESET_MFA', 'REACTIVATE']),
    user_id: z.uuid(),
    reason: z.string().min(8).max(2000),
    identity_verified: z.literal(true),
  })
  .strict();
const changeSchema = access
  .extend({ action: z.literal('CHANGE_PASSWORD'), password: z.string().min(12).max(1024) })
  .strict();
const resumeSchema = z
  .object({
    action: z.literal('RESUME'),
    job_id: z.uuid(),
    grant_id: z.uuid(),
    password: z.string().min(12).max(1024).optional(),
  })
  .strict();
const jobSchema = z.object({
  id: z.uuid(),
  target_user_id: z.uuid(),
  status: z.string(),
  action: z.enum([
    'CREATE',
    'RESET_PASSWORD',
    'RESET_MFA',
    'DISABLE',
    'REACTIVATE',
    'CHANGE_PASSWORD',
  ]),
  values: z.record(z.string(), z.unknown()),
  lease_token: z.uuid().nullable(),
});

Deno.serve(
  endpoint(
    z.discriminatedUnion('action', [
      createSchema,
      resetSchema,
      recoverySchema,
      changeSchema,
      resumeSchema,
    ]),
    async (body, request) => {
      const caller = userClient(request),
        administrator = serverClient(request);
      const { data: identity, error: identityError } = await caller.auth.getUser();
      if (identityError || !identity.user) throw new Error('UNAUTHORIZED');
      await rateLimit(
        `staff-admin:${identity.user.id}:${await rateKey(request)}`,
        10,
        600,
        request,
      );

      const completed = async (job: string, user: string) => {
        if ('password' in body && body.password) {
          const { error } = await administrator.rpc('verify_staff_job_secret', {
            p_job: job,
            p_fingerprint: await staffPasswordFingerprint(job, body.password),
          });
          if (error) throw staffCommandError(error);
        }
        return { id: user, job_id: job, status: 'COMPLETED' };
      };

      let jobId: string;
      if (body.action === 'RESUME') {
        const { data, error } = await caller.rpc('resume_staff_admin_job', {
          p_job: body.job_id,
          p_grant: body.grant_id,
        });
        if (error) throw staffCommandError(error);
        const resumed = z
          .object({ id: z.uuid(), target_user_id: z.uuid(), status: z.string() })
          .parse(data);
        if (resumed.status === 'COMPLETED') return completed(resumed.id, resumed.target_user_id);
        jobId = resumed.id;
      } else {
        const values =
          body.action === 'CREATE'
            ? {
                display_name: body.display_name,
                identifier: body.identifier.toLowerCase(),
                role: body.role,
                scope: body.scope,
                venue_ids: body.venue_ids,
              }
            : body.action === 'CHANGE_PASSWORD'
              ? {}
              : {
                  user_id: body.user_id,
                  reason: body.reason,
                  identity_verified: body.identity_verified,
                };
        const { data, error } =
          body.action === 'CHANGE_PASSWORD'
            ? await caller.rpc('begin_own_password_job', {
                p_key: body.idempotency_key,
                p_grant: body.grant_id,
              })
            : await caller.rpc('begin_staff_admin_job', {
                p_action: body.action,
                p_values: values,
                p_key: body.idempotency_key,
                p_grant: body.grant_id,
              });
        if (error) throw staffCommandError(error);
        const prepared = z
          .object({ id: z.uuid(), user_id: z.uuid(), status: z.string() })
          .parse(data);
        if (prepared.status === 'COMPLETED') return completed(prepared.id, prepared.user_id);
        jobId = prepared.id;
      }

      const { data: claimed, error: claimError } = await administrator.rpc(
        'claim_staff_admin_job',
        { p_job: jobId },
      );
      if (claimError) throw staffCommandError(claimError);
      const job = jobSchema.parse(claimed);
      if (job.status === 'COMPLETED') return completed(job.id, job.target_user_id);
      if (!job.lease_token) throw new Error('INVALID_STAFF_COMMAND');

      try {
        if (
          ['CREATE', 'RESET_PASSWORD', 'CHANGE_PASSWORD'].includes(job.action) &&
          'password' in body &&
          body.password
        ) {
          const { error } = await administrator.rpc('bind_staff_job_secret', {
            p_job: job.id,
            p_lease: job.lease_token,
            p_fingerprint: await staffPasswordFingerprint(job.id, body.password),
          });
          if (error) throw staffCommandError(error);
        }

        let {
          data: { user },
          error: readError,
        } = await administrator.auth.admin.getUserById(job.target_user_id);
        if (readError && readError.status !== 404) throw new Error('REQUEST_FAILED');

        if (job.action === 'CREATE') {
          if (!user) {
            if (!('password' in body) || !body.password)
              throw new Error('PASSWORD_REQUIRED_FOR_RECOVERY');
            const { data, error } = await administrator.auth.admin.createUser({
              id: job.target_user_id,
              email: z.email().parse(job.values.identifier),
              password: body.password,
              email_confirm: true,
              ban_duration: '876000h',
              app_metadata: { plateform_staff_command_id: job.id },
            });
            if (error || !data.user) throw new Error('REQUEST_FAILED');
            user = data.user;
          }
          if (user.app_metadata.plateform_staff_command_id !== job.id)
            throw new Error('PROVISIONING_IDENTITY_MISMATCH');
          const { error } = await administrator.rpc('prepare_staff_job_profile', {
            p_job: job.id,
            p_lease: job.lease_token,
          });
          if (error) throw new Error('REQUEST_FAILED');
          const { error: unbanError } = await administrator.auth.admin.updateUserById(
            job.target_user_id,
            { ban_duration: 'none' },
          );
          if (unbanError) throw new Error('REQUEST_FAILED');
        } else {
          if (!user) throw new Error('REQUEST_FAILED');
          if (job.action === 'RESET_MFA') {
            const { data, error } = await administrator.auth.admin.mfa.listFactors({
              userId: job.target_user_id,
            });
            if (error) throw new Error('REQUEST_FAILED');
            for (const factor of data.factors) {
              const { error: deleteError } = await administrator.auth.admin.mfa.deleteFactor({
                userId: job.target_user_id,
                id: factor.id,
              });
              if (deleteError) throw new Error('REQUEST_FAILED');
            }
          } else if (user.app_metadata.plateform_staff_command_id !== job.id) {
            if (
              ['RESET_PASSWORD', 'CHANGE_PASSWORD'].includes(job.action) &&
              (!('password' in body) || !body.password)
            )
              throw new Error('PASSWORD_REQUIRED_FOR_RECOVERY');
            const { error } = await administrator.auth.admin.updateUserById(job.target_user_id, {
              ...(['RESET_PASSWORD', 'CHANGE_PASSWORD'].includes(job.action) &&
              'password' in body &&
              body.password
                ? { password: body.password }
                : {}),
              ban_duration: job.action === 'DISABLE' ? '876000h' : 'none',
              app_metadata: { ...user.app_metadata, plateform_staff_command_id: job.id },
            });
            if (error) throw new Error('REQUEST_FAILED');
          }
        }

        const { data, error } = await administrator.rpc('finish_staff_admin_job', {
          p_job: job.id,
          p_lease: job.lease_token,
          p_success: true,
        });
        if (error) throw new Error('REQUEST_FAILED');
        return data;
      } catch (error) {
        await administrator.rpc('finish_staff_admin_job', {
          p_job: job.id,
          p_lease: job.lease_token,
          p_success: false,
        });
        if (
          error instanceof Error &&
          ['IDEMPOTENCY_MISMATCH', 'PASSWORD_REQUIRED_FOR_RECOVERY'].includes(error.message)
        )
          throw error;
        throw new Error('STAFF_COMMAND_RECOVERY_REQUIRED');
      }
    },
  ),
);
