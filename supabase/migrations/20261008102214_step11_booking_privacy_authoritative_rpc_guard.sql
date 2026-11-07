
do $migration$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.get_booking_configuration(uuid)'::regprocedure);
  v_old := 'and private.installation_active()';
  v_new := 'and private.public_booking_ready(v.id)';
  if v_def is null or position(v_old in v_def)=0 or position(v_new in v_def)>0
  then raise exception 'STEP11_BOOKING_CONFIG_FUNCTION_CHANGED'; end if;
  execute replace(v_def,v_old,v_new);

  v_def := pg_get_functiondef('public.get_public_booking_availability(uuid,uuid,date,integer)'::regprocedure);
  v_old := $old$
  if v_venue.id is null
     or not private.installation_active()
     or not exists(
       select 1
       from public.venue_settings
       where venue_id=p_venue
         and reservations_enabled
     )
  then
    raise exception 'RESERVATIONS_DISABLED';
  end if;
$old$;
  v_new := $new$
  if v_venue.id is null
     or not private.public_booking_ready(p_venue)
  then
    raise exception 'RESERVATIONS_DISABLED';
  end if;
$new$;
  if v_def is null or position(v_old in v_def)=0 or position(v_new in v_def)>0
  then raise exception 'STEP11_AVAILABILITY_FUNCTION_CHANGED'; end if;
  execute replace(v_def,v_old,v_new);

  v_def := pg_get_functiondef('public.create_public_reservation(uuid,uuid,date,time without time zone,text,text,text,integer,jsonb,uuid,text)'::regprocedure);
  v_old := $old$
  if v.id is null
     or not private.installation_active()
     or not exists(
       select 1 from public.venue_settings
       where venue_id=v.id and reservations_enabled
     )
  then
    raise exception 'RESERVATIONS_DISABLED';
  end if;
$old$;
  v_new := $new$
  if v.id is null
     or not private.public_booking_ready(p_venue)
  then
    raise exception 'RESERVATIONS_DISABLED';
  end if;
$new$;
  if v_def is null or position(v_old in v_def)=0 or position(v_new in v_def)>0
  then raise exception 'STEP11_RESERVATION_FUNCTION_CHANGED'; end if;
  execute replace(v_def,v_old,v_new);
end
$migration$;
