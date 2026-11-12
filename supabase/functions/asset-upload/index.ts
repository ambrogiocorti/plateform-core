import { validFile } from '../_shared/assets.ts';
import { z } from 'npm:zod@4.6.7';
import { endpoint, rateLimit, serverClient, userClient } from '../_shared/http.ts';

const schema = z
  .object({
    bucket: z.enum(['branding', 'dishes', 'gallery', 'documents']),
    resource_id: z.uuid().nullable(),
    venue_id: z.uuid().nullable(),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']),
    content_base64: z
      .string()
      .min(4)
      .max(6990508)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    idempotency_key: z.uuid(),
  })
  .strict();

const checksum = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

Deno.serve(
  endpoint(
    schema,
    async (body, request) => {
      const user = userClient(request),
        server = serverClient(request);
      const { data: identity, error } = await user.auth.getUser();
      if (error || !identity.user) throw new Error('UNAUTHORIZED');
      await rateLimit(`assets:${identity.user.id}`, 20, 600, request);
      const bytes = Uint8Array.from(atob(body.content_base64), (char) => char.charCodeAt(0));
      if (bytes.length < 1 || bytes.length > 5242880 || !validFile(bytes, body.mime))
        throw new Error('INVALID_ASSET');
      const hash = await checksum(bytes);
      const { data, error: reserveError } = await user.rpc('reserve_asset_upload_command', {
        p_bucket: body.bucket,
        p_resource: body.resource_id,
        p_venue: body.venue_id,
        p_size: bytes.length,
        p_mime: body.mime,
        p_checksum: hash,
        p_key: body.idempotency_key,
      });
      if (reserveError)
        throw new Error(
          [
            'STORAGE_LIMIT',
            'CHAIN_SCOPE_REQUIRED',
            'INVALID_ASSET',
            'IDEMPOTENCY_MISMATCH',
          ].includes(reserveError.message)
            ? reserveError.message
            : 'FORBIDDEN',
        );
      const reserved = z.object({ id: z.uuid(), path: z.string() }).parse(data);
      const stored = server.storage.from(body.bucket);
      const { error: uploadError } = await stored.upload(reserved.path, bytes, {
        contentType: body.mime,
        upsert: false,
      });
      if (uploadError) {
        // A timeout or duplicate path can mean that the first attempt committed.
        const { data: existing, error: downloadError } = await stored.download(reserved.path);
        if (downloadError || !existing) throw new Error('ASSET_RECOVERY_REQUIRED');
        const actual = new Uint8Array(await existing.arrayBuffer());
        if (actual.length !== bytes.length || (await checksum(actual)) !== hash)
          throw new Error('ASSET_RECOVERY_REQUIRED');
      }
      const { error: finishError } = await server.rpc('finish_asset_upload', {
        p_id: reserved.id,
        p_success: true,
        p_checksum: hash,
      });
      if (finishError) throw new Error('ASSET_RECOVERY_REQUIRED');
      return {
        id: reserved.id,
        path: reserved.path,
        url: body.bucket === 'documents' ? null : stored.getPublicUrl(reserved.path).data.publicUrl,
      };
    },
    { maxBytes: 7100000 },
  ),
);
