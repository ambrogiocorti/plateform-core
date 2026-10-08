import { z } from 'npm:zod@4.6.5';
import { endpoint, rateLimit, secret, userClient } from '../_shared/http.ts';
import { eposDocument, type PrintPayload } from '../../../shared/print-document.ts';
import { documentHash, signPrintAuthorization } from '../../../shared/print-authorization.ts';
import { epsonPrintingIncluded } from '../../../src/services/commercial-scope.ts';
const schema = z.object({ job_id: z.uuid(), lease_id: z.uuid() }).strict();
Deno.serve(
  endpoint(schema, async (body, request) => {
    const user = userClient(request);
    const { data: identity, error } = await user.auth.getUser();
    if (error || !identity.user) throw new Error('UNAUTHORIZED');
    // CORE can render browser/PDF documents, but must never sign a bridge/Epson job.
    if (!epsonPrintingIncluded) throw new Error('PRINT_DRIVER_NOT_INCLUDED');
    await rateLimit(`print:${identity.user.id}`, 60, 60, request);
    const { data, error: authorizeError } = await user.rpc('get_print_bridge_authorization', {
      p_job: body.job_id,
      p_lease: body.lease_id,
    });
    if (authorizeError) throw new Error('FORBIDDEN');
    const job = z
      .object({
        job_id: z.uuid(),
        device_id: z.uuid(),
        lease_id: z.uuid(),
        expires_at: z.iso.datetime({ offset: true }),
        bridge_url: z.url(),
        staff_url: z.url(),
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(data);
    const document = eposDocument(job.payload as unknown as PrintPayload);
    if (new TextEncoder().encode(document).byteLength > 65536) throw new Error('PAYLOAD_TOO_LARGE');
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(job.staff_url).origin) throw new Error('FORBIDDEN');
    return {
      document,
      authorization: await signPrintAuthorization(
        {
          audience: 'plateform-print-bridge',
          issuer: new URL(secret('SUPABASE_URL')).origin,
          bridge_origin: new URL(job.bridge_url).origin,
          staff_origin: origin,
          job_id: job.job_id,
          device_id: job.device_id,
          lease_id: job.lease_id,
          document_sha256: await documentHash(document),
          issued_at: new Date().toISOString(),
          expires_at: job.expires_at,
        },
        JSON.parse(secret('PRINT_SIGNING_PRIVATE_JWK')),
      ),
    };
  }),
);
