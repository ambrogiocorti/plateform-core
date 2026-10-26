
insert into private.release_test_catalog(key,category,required,description) values
  ('MENU_SCHEDULE_ENGINE','REGRESSION',true,'Menu scheduling supports date/day/time windows including overnight service ranges.'),
  ('PUBLIC_MENU_QR_ISOLATION','SECURITY',true,'Anonymous menu access by stable QR id or slug exposes only categories/dishes authorized for that menu and venue.'),
  ('MENU_PROMOTION_EXPIRY','REGRESSION',true,'Expired promotions are excluded server-side and promotions cannot alter authoritative dish pricing.')
on conflict(key) do nothing;
