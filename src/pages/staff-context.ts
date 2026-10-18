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
  const multiVenue = flags.some((flag) => flag.name === 'MULTI_VENUE' && flag.licensed);
  // The tab keeps its own choice; a new tab reopens the venue saved on this device by the server.
  const selected =
    sessionStorage.getItem('plateform-venue') ??
    (multiVenue && venues.length > 1 ? await deviceVenue() : null);
  return {
    profile,
    venues,
    venue: venues.find((venue) => venue.id === selected) ?? venues[0] ?? null,
    multiVenue,
    licensedFeatures: new Set(flags.filter((flag) => flag.licensed).map((flag) => flag.name)),
    navigate,
  };
}

const venueContextSchema = z.object({ current_venue_id: z.uuid().nullable() }).loose();

async function deviceVenue(): Promise<string | null> {
  try {
    return (await rpc('get_staff_venue_context', {}, venueContextSchema)).current_venue_id;
  } catch {
    return null;
  }
}

// STEP 10: the operational venue is a server-side property of the registered device (Device
// Management, offline authorization), not only of this browser tab. The server checks that the
// venue is authorized and that the device is still active before the tab switches.
export async function selectVenue(venue: string): Promise<void> {
  await rpc('set_operational_venue', { p_venue: venue }, venueContextSchema);
  sessionStorage.setItem('plateform-venue', venue);
}

export const voidResult = z.null();
export async function command(name: string, args: Record<string, unknown>): Promise<void> {
  await rpc(name, args, voidResult);
}
