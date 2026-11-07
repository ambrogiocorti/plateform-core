
create index if not exists customer_order_requests_requested_by_fk_idx
on public.customer_order_requests(requested_by);

create index if not exists customer_order_requests_venue_account_fk_idx
on public.customer_order_requests(venue_id,account_id);

create index if not exists customer_order_requests_venue_order_fk_idx
on public.customer_order_requests(venue_id,order_id);

create index if not exists dishes_category_fk_idx
on public.dishes(category_id);
