import { z } from 'zod';
import { floorSchema } from '../components/floor-view';
export const offlineWorkspaceSchema = z.object({
  captured_at: z.string(),
  floor: floorSchema.nullable(),
  accounts: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      version: z.number().int().positive(),
      table_id: z.uuid(),
    }),
  ),
  steps: z.array(
    z.object({
      id: z.uuid(),
      version: z.number().int().positive(),
      number: z.number().int(),
      table_name: z.string(),
      can_start: z.boolean(),
    }),
  ),
  reset_tables: z.array(
    z.object({ id: z.uuid(), name: z.string(), version: z.number().int().positive() }),
  ),
  kitchen: z.array(
    z.object({
      id: z.uuid(),
      step_id: z.uuid(),
      step_number: z.number().int(),
      table_name: z.string(),
      dish_name: z.string(),
      quantity: z.number().int(),
      status: z.string(),
      removed_ingredients: z.array(z.string()),
      variants: z.array(z.object({ group: z.string(), option: z.string() })),
    }),
  ),
});
export const offlineWorkspaceKey = (user: string, venue: string) => `operations:${user}:${venue}`;
