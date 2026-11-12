import { z } from 'zod';

const accessSchema = z.object({
  deposit: z.uuid(),
  venue: z.uuid(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  saved_at: z.number().int().nonnegative(),
});
const lifetime = 24 * 60 * 60 * 1000;
type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type DepositAccess = Pick<z.infer<typeof accessSchema>, 'deposit' | 'venue' | 'token'>;

/** Keep the guest's capability in this tab, never in a URL, log or persistent localStorage. */
export function rememberDepositAccess(
  store: SessionStore,
  access: DepositAccess,
  now = Date.now(),
): boolean {
  try {
    const value = accessSchema.parse({ ...access, saved_at: now });
    store.setItem(`plateform-deposit:${value.deposit}`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function pendingDepositAccess(
  store: SessionStore,
  deposit: string,
  venue: string,
  now = Date.now(),
): DepositAccess | null {
  if (!z.uuid().safeParse(deposit).success) return null;
  try {
    const key = `plateform-deposit:${deposit}`;
    const raw = store.getItem(key);
    if (!raw) return null;
    const result = accessSchema.safeParse(JSON.parse(raw));
    if (
      !result.success ||
      result.data.deposit !== deposit ||
      result.data.venue !== venue ||
      result.data.saved_at > now ||
      now - result.data.saved_at >= lifetime
    ) {
      store.removeItem(key);
      return null;
    }
    const { token } = result.data;
    return { deposit, venue, token };
  } catch {
    return null;
  }
}
