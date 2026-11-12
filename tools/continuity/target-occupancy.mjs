/**
 * Independent, read-only preflight. Treat a target as occupied if it already
 * contains any application-owned schema, data or functions. A populated target
 * must never be mistaken for a disposable database merely because the
 * restaurant_profile table has not yet been installed.
 *
 * This is not a substitute for a dedicated, isolated restore target, explicit
 * destructive acknowledgement or an object-level Storage empty check.
 */
export const TARGET_OCCUPANCY_SQL = `
SELECT CASE WHEN
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind IN ('r', 'p')
  )
  OR EXISTS (SELECT 1 FROM auth.users)
  OR EXISTS (SELECT 1 FROM storage.objects)
  OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
  )
THEN 'occupied' ELSE 'empty' END;
`;

export function parseTargetOccupancy(output) {
  const state = String(output).trim();
  if (state === 'occupied') return true;
  if (state === 'empty') return false;
  // Missing/garbled/incomplete psql output must never authorize restore.
  throw new Error('RESTORE_TARGET_OCCUPANCY_UNVERIFIED');
}
