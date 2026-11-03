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
  const [allVenues, flags, serverContext] = await Promise.all([
    readRows('venues', venueSchema),
    readRows('feature_flags', z.object({ name: z.string(), licensed: z.boolean() })),
    rpc(
      'get_staff_venue_context',
      {},
      z.object({
        current_venue_id: z.uuid(),
        multi_venue: z.boolean(),
        venues: z.array(z.object({ id: z.uuid() })),
      }),
    ),
  ]);
  const allowed = new Set(serverContext.venues.map((venue) => venue.id));
  const venues = allVenues.filter((venue) => allowed.has(venue.id));
  return {
    profile,
    venues,
    venue: venues.find((venue) => venue.id === serverContext.current_venue_id) ?? venues[0] ?? null,
    multiVenue: serverContext.multi_venue,
    licensedFeatures: new Set(flags.filter((flag) => flag.licensed).map((flag) => flag.name)),
    navigate,
  };
}

export const voidResult = z.null();
export async function command(name: string, args: Record<string, unknown>): Promise<void> {
  await rpc(name, args, voidResult);
}
