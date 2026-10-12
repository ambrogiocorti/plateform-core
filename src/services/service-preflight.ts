export interface ServiceDish {
  id: string;
  active: boolean;
}

export interface ServiceVenueDish {
  dish_id: string;
  enabled: boolean;
  availability: number | null;
  local_station_id: string | null;
}

export interface ServiceDishStation {
  dish_id: string;
  station_id: string;
  is_primary: boolean;
}

export interface ServiceStation {
  id: string;
  active: boolean;
}

export interface ServiceStaff {
  id: string;
  role: string;
  active: boolean;
}

export interface ServiceStaffVenue {
  user_id: string;
  active: boolean;
}

export interface ServiceStaffStation {
  user_id: string;
  station_id: string;
  active: boolean;
}

export interface ServicePreflightInput {
  dishes: readonly ServiceDish[] | null;
  venueDishes: readonly ServiceVenueDish[] | null;
  dishStations: readonly ServiceDishStation[] | null;
  stations: readonly ServiceStation[];
  profiles: readonly ServiceStaff[];
  venueStaff: readonly ServiceStaffVenue[];
  stationStaff: readonly ServiceStaffStation[];
}

export interface ServicePreflightResult {
  orderableRoutedDishes: number | null;
  waiterAssigned: boolean;
  kitchenStaffed: boolean;
  passAssigned: boolean;
}

/**
 * Conservative readiness evidence only. It does not replace server-side
 * create_order availability checks, RLS, service staffing or a real test order.
 */
export function evaluateServicePreflight(input: ServicePreflightInput): ServicePreflightResult {
  const activeStationIds = new Set(
    input.stations.filter((station) => station.active).map((station) => station.id),
  );
  const activeVenueUserIds = new Set(
    input.venueStaff.filter((assignment) => assignment.active).map((assignment) => assignment.user_id),
  );
  const activeUsers = input.profiles.filter(
    (profile) => profile.active && activeVenueUserIds.has(profile.id),
  );
  const kitchenStaffed = activeUsers.some(
    (profile) =>
      profile.role === 'KITCHEN_ADMIN' ||
      (profile.role === 'KITCHEN_STAFF' &&
        input.stationStaff.some(
          (assignment) =>
            assignment.active &&
            assignment.user_id === profile.id &&
            activeStationIds.has(assignment.station_id),
        )),
  );

  let orderableRoutedDishes: number | null = null;
  if (input.dishes && input.venueDishes && input.dishStations) {
    const activeDishes = new Set(
      input.dishes.filter((dish) => dish.active).map((dish) => dish.id),
    );
    const primaryStations = new Map(
      input.dishStations
        .filter((assignment) => assignment.is_primary)
        .map((assignment) => [assignment.dish_id, assignment.station_id]),
    );
    orderableRoutedDishes = input.venueDishes.filter((settings) => {
      if (!settings.enabled || !activeDishes.has(settings.dish_id)) return false;
      if (settings.availability !== null && settings.availability <= 0) return false;
      // A local station override takes precedence over the shared primary
      // station; never fall back when that override is disabled or missing.
      const destination =
        settings.local_station_id ?? primaryStations.get(settings.dish_id);
      return destination !== undefined && activeStationIds.has(destination);
    }).length;
  }

  return {
    orderableRoutedDishes,
    waiterAssigned: activeUsers.some((profile) => profile.role === 'WAITER'),
    kitchenStaffed,
    passAssigned: activeUsers.some((profile) => profile.role === 'PASS'),
  };
}
