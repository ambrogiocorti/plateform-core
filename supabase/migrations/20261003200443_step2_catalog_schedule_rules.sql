begin;
alter table public.dishes drop constraint dishes_check;
alter table public.dishes add constraint dishes_schedule_consistency_check check (
  (schedule_mode='ALWAYS' and available_from is null and available_until is null and cardinality(weekdays)=0)
  or (schedule_mode='DATE' and available_from is not null and available_until is null and cardinality(weekdays)=0)
  or (schedule_mode='WEEKDAYS' and available_from is null and available_until is null and cardinality(weekdays)>0)
  or (schedule_mode='RANGE' and available_from is not null and available_until is not null and available_until>=available_from and cardinality(weekdays)=0)
);
commit;