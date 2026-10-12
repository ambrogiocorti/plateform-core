
insert into private.master_acceptance_requirements(key,section,requirement) values
  ('E2E_MONO_VENUE_NO_SELECTOR','E2E','mono-venue experience without venue selector'),
  ('E2E_ENABLE_MULTI_VENUE','E2E','enable multi-venue flow'),
  ('E2E_USER_SINGLE_VENUE','E2E','user assigned to one venue'),
  ('E2E_USER_MULTI_VENUE','E2E','multi-venue user flow'),
  ('E2E_CROSS_VENUE_DENIED','E2E','cross-venue access denied'),
  ('E2E_MENU_VENUE_OVERRIDE','E2E','menu with venue override'),
  ('E2E_BOOKING_PACING','E2E','booking pacing'),
  ('E2E_LARGE_GROUP_REQUESTED','E2E','large group enters REQUESTED'),
  ('E2E_REMINDER_NO_DUPLICATES','E2E','reservation reminder without duplicates'),
  ('E2E_MESSAGING_CONFIRMATION','E2E','WhatsApp/Telegram/SMS or messaging confirmation flow'),
  ('E2E_RESERVATION_DEPOSIT','E2E','reservation deposit flow'),
  ('E2E_NO_SHOW_GRACE_PERIOD','E2E','no-show after grace period'),
  ('E2E_WAITLIST_TO_RESERVATION','E2E','waitlist to offer to reservation'),
  ('E2E_TAKEAWAY_LIFECYCLE','E2E','takeaway to kitchen to READY_FOR_PICKUP to COLLECTED'),
  ('E2E_FOOD_COST_MENU_ENGINEERING','E2E','food cost and menu engineering with controlled dataset'),
  ('E2E_PROMOTION_VALIDITY','E2E','popup/promotion validity period'),
  ('E2E_DIFFERENT_QR_MENUS','E2E','different QR codes expose different menus'),
  ('E2E_NOTIFICATION_CENTER','E2E','Notification Center flow'),
  ('E2E_CONFLICT_CENTER','E2E','Conflict Center flow'),
  ('E2E_SUPER_ADMIN_MFA','E2E','Super Admin MFA flow'),
  ('E2E_COMMAND_PALETTE_AUTHORIZATION','E2E','authorized command palette and critical shortcuts')
on conflict(key) do nothing;
