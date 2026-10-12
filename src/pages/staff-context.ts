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
  const [venues, flags] = await Promise.all([
    readRows('venues', venueSchema),
    readRows('feature_flags', z.object({ name: z.string(), licensed: z.boolean() })),
  ]);
  const selected = sessionStorage.getItem('plateform-venue');
  return {
    profile,
    venues,
    venue: venues.find((venue) => venue.id === selected) ?? venues[0] ?? null,
    multiVenue: flags.some((flag) => flag.name === 'MULTI_VENUE' && flag.licensed),
    licensedFeatures: new Set(flags.filter((flag) => flag.licensed).map((flag) => flag.name)),
    navigate,
  };
}

export const voidResult = z.null();
export async function command(name: string, args: Record<string, unknown>): Promise<void> {
  await rpc(name, args, voidResult);
}
