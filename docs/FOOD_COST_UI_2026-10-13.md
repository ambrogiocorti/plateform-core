# Plateform Food Cost UI — commercial module implementation

Date: 13 October 2026. Status: **feature code added; production integration not certified**.

## Backend already in Development
- `public.set_ingredient_cost(ingredient,venue,cost_micros,unit,effective_from,source,idempotency_key)` writes an append-only effective-period price (closing prior quote); scoped to ADMIN with FOOD_COST licensed.
- `public.get_dish_food_cost(dish,venue)` calculates complete/partial recipe lines, incidence and margin; scoped to ADMIN.
- `public.snapshot_dish_food_cost(dish,venue,key)` stores an immutable reporting snapshot; scoped to ADMIN and requires complete recipe pricing.
- `public.save_dish_composition` accepts quantity, unit, yield factor, waste percentage in each ingredient when FOOD_COST is licensed. These constraints are enforced in `public.configure_dish`.

## Added UI
- In the existing Ingredients configuration: **Registra costo acquisto**, unit G/KG/ML/L/PIECE, euro micros with six decimals, source and per-venue history.
- In the existing Dish composition dialog: optional quantity/unit/yield/waste fields when FOOD_COST licensed, preserving the existing CORE contract when disabled.
- In the existing Dishes configuration: **Food cost e margine** shows complete/partial recipe, line costs, incidence and gross margin, with a separate snapshot command only if complete.
- All writes use the real server procedures with idempotency UUIDs; buttons are hidden when the remote FOOD_COST flag is not licensed. Server remains the authority for role, venue, entitlement and input validation.

## Caveats and release
- No license has been activated in Development; this UI cannot be exercised there until a controlled test license is configured in isolated staging.
- Backend may reject incompatible unit dimensions or effective timestamps, reported via shared error handler.
- Vercel candidate build tests ensure TypeScript, lint, runtime import, unit money precision and database tests; actual HTTPS Auth/RLS/E2E is still a release gate.
- Does not imply all Release 3/4 commercial features are complete.
