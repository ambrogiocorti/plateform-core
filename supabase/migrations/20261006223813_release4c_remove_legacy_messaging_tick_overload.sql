
drop function if exists public.run_reservation_messaging_tick();

delete from private.api_permission_manifest
where function_identity='public.run_reservation_messaging_tick()';
