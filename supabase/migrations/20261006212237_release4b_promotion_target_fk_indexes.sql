
create index if not exists menu_promotions_target_category_idx
on public.menu_promotions(target_category_id)
where target_category_id is not null;

create index if not exists menu_promotions_target_dish_idx
on public.menu_promotions(target_dish_id)
where target_dish_id is not null;

create index if not exists menu_promotions_target_menu_idx
on public.menu_promotions(target_menu_id)
where target_menu_id is not null;
