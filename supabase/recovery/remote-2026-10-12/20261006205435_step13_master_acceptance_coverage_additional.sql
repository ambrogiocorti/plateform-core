
insert into private.master_acceptance_requirements(key,section,requirement) values
  ('ADD_REMINDER_EXACTLY_ONCE_RETRY','ADDITIONAL','reminder sent exactly once even with retry'),
  ('ADD_MESSAGING_FAILURE_PRESERVES_RESERVATION','ADDITIONAL','WhatsApp/Telegram/SMS failure does not lose reservation'),
  ('ADD_DEPOSIT_SERVER_AUTHORITATIVE','ADDITIONAL','deposit confirmed only server-side'),
  ('ADD_WAITLIST_LAST_SLOT_RACE','ADDITIONAL','two users cannot obtain same last waitlist slot'),
  ('ADD_TAKEAWAY_LAST_SLOT_RACE','ADDITIONAL','two users cannot obtain same last takeaway slot'),
  ('ADD_FOOD_COST_RECALC_PRESERVES_HISTORY','ADDITIONAL','food cost recalculates after ingredient cost change without altering historical snapshot'),
  ('ADD_QR_MENU_AUTHORIZATION','ADDITIONAL','breakfast QR does not expose unauthorized menus or private data'),
  ('ADD_EXPIRED_PROMOTION_HIDDEN','ADDITIONAL','expired promotion disappears automatically'),
  ('ADD_TAKEAWAY_AVAILABILITY_NONNEGATIVE','ADDITIONAL','takeaway decrements availability without making it negative')
on conflict(key) do nothing;
