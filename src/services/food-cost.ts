/** Exact price in EUR micros (six decimal places); never use floating-point money. */
export function parsePurchaseCostMicros(value: string): number {
  const match = /^([0-9]{1,6})(?:[.,]([0-9]{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error('Inserisci un costo positivo in euro, massimo sei decimali.');
  const euros = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'));
  const micros = euros * 1_000_000n + fraction;
  if (micros <= 0n || micros > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Il costo deve essere positivo e valido.');
  return Number(micros);
}
