import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database } from './harness';

// Deliberately public data-only RPCs plus the RLS helper for public realtime
// signals. Changes to this list require security review of grants and bodies.
const reviewedAnonymousPrivilegedSurface = [
  'private.can_read_signal(p_signal realtime_signals)',
  'public.get_booking_configuration(p_venue uuid)',
  'public.get_public_booking_availability(p_venue uuid, p_service uuid, p_date date, p_party integer)',
  'public.get_public_menu(p_venue uuid)',
  'public.get_public_menu_by_id(p_public_menu uuid, p_venue uuid)',
  'public.get_public_menu_by_slug(p_slug text, p_venue uuid)',
  'public.get_public_menu_index(p_venue uuid)',
  'public.get_public_navigation(p_venue uuid)',
  'public.get_public_page_metadata(p_path text, p_venue uuid)',
  'public.get_public_site()',
  'public.get_public_sitemap_entries()',
];

describe('anonymous privileged RPC exposure inventory', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('does not grant anon access to unreviewed SECURITY DEFINER procedures', async () => {
    const { rows } = await db.query<{ signature: string }>(`
      select format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) as signature
      from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('private','public')
        and p.prosecdef
        and has_function_privilege('anon',p.oid,'EXECUTE')
      order by signature
    `);
    expect(rows.map((row) => row.signature)).toEqual(reviewedAnonymousPrivilegedSurface);
  });
});
