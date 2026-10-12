export interface ServiceDish {
  id: string;
  category_id: string;
  active: boolean;
  schedule_mode: string;
  available_from: string | null;
  available_until: string | null;
  weekdays: readonly number[] | null;
}

export interface ServiceCategory {
  id: string;
  active: boolean;
}

export interface ServiceVenueDish {
  dish_id: string;
  enabled: boolean;
  availability: number | null;
  availability_date: string | null;
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
  categories: readonly ServiceCategory[] | null;
  localDate: string;
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
  if (input.dishes && input.categories && input.venueDishes && input.dishStations) {
    const activeCategories = new Set(
      input.categories.filter((category) => category.active).map((category) => category.id),
    );
    const weekday = new Date(`${input.localDate}T12:00:00Z`).getUTCDay() || 7;
    const settingsByDish = new Map(
      input.venueDishes.map((settings) => [settings.dish_id, settings]),
    );
    const primaryStations = new Map(
      input.dishStations
        .filter((assignment) => assignment.is_primary)
        .map((assignment) => [assignment.dish_id, assignment.station_id]),
    );
    orderableRoutedDishes = input.dishes.filter((dish) => {
      if (!dish.active || !activeCategories.has(dish.category_id)) return false;
      const scheduleAllowed =
        dish.schedule_mode === 'ALWAYS' ||
        (dish.schedule_mode === 'DATE' && dish.available_from === input.localDate) ||
        (dish.schedule_mode === 'WEEKDAYS' && (dish.weekdays?.includes(weekday) ?? false)) ||
        (dish.schedule_mode === 'RANGE' &&
          dish.available_from !== null &&
          dish.available_until !== null &&
          dish.available_from <= input.localDate &&
          input.localDate <= dish.available_until);
      if (!scheduleAllowed) return false;
      const settings = settingsByDish.get(dish.id);
      // Absence of an override means ENABLED in get_public_menu.
      if (settings?.enabled === false) return false;
      // An explicit count expires when availability_date is not the local day.
      if (
        settings?.availability !== null &&
        settings?.availability !== undefined &&
        (settings.availability <= 0 || settings.availability_date !== input.localDate)
      ) return false;
      // A local station override takes precedence over the shared primary;
      // it must itself refer to an ACTIVE station.
      const destination =
        settings?.local_station_id ?? primaryStations.get(dish.id);
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
