export type VenueDishSetupState =
  | 'DISABLED'
  | 'SOLD_OUT'
  | 'NEEDS_STATION'
  | 'CONFIGURED';

export interface VenueDishSettingsForStatus {
  enabled: boolean;
  availability: number | null;
  availability_date: string | null;
  local_station_id: string | null;
}

export function venueDishSetupState(
  settings: VenueDishSettingsForStatus | undefined,
  primaryStationId: string | undefined,
  activeStationIds: ReadonlySet<string>,
  localDate: string,
): VenueDishSetupState {
  if (settings?.enabled === false) return 'DISABLED';
  if (
    settings?.availability !== null &&
    settings?.availability !== undefined &&
    (settings.availability <= 0 || settings.availability_date !== localDate)
  ) return 'SOLD_OUT';
  // A per-venue station override is authoritative, even if no longer active.
  const effectiveStation = settings?.local_station_id ?? primaryStationId;
  if (!effectiveStation || !activeStationIds.has(effectiveStation)) return 'NEEDS_STATION';
  return 'CONFIGURED';
}
