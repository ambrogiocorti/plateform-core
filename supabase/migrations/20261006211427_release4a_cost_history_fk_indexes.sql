
create index if not exists ingredient_cost_history_created_by_idx
on public.ingredient_cost_history(created_by)
where created_by is not null;

create index if not exists dish_food_cost_snapshots_created_by_idx
on public.dish_food_cost_snapshots(created_by);
