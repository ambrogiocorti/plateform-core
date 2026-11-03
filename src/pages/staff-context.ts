import { z } from 'zod';
import { readRows, rpc } from '../api/client';
import { venueSchema } from '../types/domain';
import type { StaffProfile, Venue } from '../types/domain';

export interface StaffContext {
  profile: StaffProfile;
  venues: Venue[];
  venue: Venue | null;
  multiVenue: boolean;
  licensedFeatures?: ReadonlySet<string>;
  navigate: (path: string) => void;
  refresh?: () => Promise<void>;
}

export async function loadContext(
  profile: StaffProfile,
  navigate: (path: string) => void,
): Promise<StaffContext> {
  const [allVenues, flags] = await Promise.all([
    readRows('venues', venueSchema),
    readRows('feature_flags', z.object({ name: z.string(), licensed: z.boolean() })),
  ]);
  const multiVenue = flags.some((flag) => flag.name === 'MULTI_VENUE' && flag.licensed);
  // In a licensed multi-venue installation, PostgreSQL owns the current
  // device selection; a second tab must not resurrect a stale local choice.
  const serverContext = multiVenue
    ? await rpc(
        'get_staff_venue_context',
        {},
        z.object({
          current_venue_id: z.uuid(),
          multi_venue: z.boolean(),
          venues: z.array(z.object({ id: z.uuid() })),
        }),
      )
    : null;
  const byId = new Map(allVenues.map((venue) => [venue.id, venue]));
  const venues = serverContext
    ? serverContext.venues.flatMap((venue) => {
        const row = byId.get(venue.id);
        return row ? [row] : [];
      })
    : allVenues;
  const selectedId = serverContext?.current_venue_id ?? sessionStorage.getItem('plateform-venue');
  return {
    profile,
    venues,
    venue: venues.find((venue) => venue.id === selectedId) ?? venues[0] ?? null,
    multiVenue,
    licensedFeatures: new Set(flags.filter((flag) => flag.licensed).map((flag) => flag.name)),
    navigate,
  };
}

export const voidResult = z.null();
export async function command(name: string, args: Record<string, unknown>): Promise<void> {
  await rpc(name, args, voidResult);
}
