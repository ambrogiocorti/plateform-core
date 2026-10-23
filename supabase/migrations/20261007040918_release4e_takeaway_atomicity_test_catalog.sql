insert into private.release_test_catalog(key,category,required,description) values
  ('TAKEAWAY_SLOT_CAPACITY_ATOMICITY','CHAOS',true,'Takeaway pickup slot is locked server-side; only capacity_orders non-cancelled orders can occupy the slot.'),
  ('TAKEAWAY_CORE_AVAILABILITY_REUSE','REGRESSION',true,'Takeaway ordering reuses the core place_order stock lock and never permits availability to go negative.'),
  ('TAKEAWAY_KDS_VISIBILITY','REGRESSION',true,'Takeaway tickets are visible in KDS without a table and show the pickup-time service label.')
on conflict(key) do nothing;