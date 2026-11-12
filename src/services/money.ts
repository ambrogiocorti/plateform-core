export function parseMoney(input: string): bigint {
  const normalized = input.trim().replace(',', '.');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(normalized))
    throw new Error('Inserisci un importo con massimo due decimali.');
  const [whole = '0', decimal = ''] = normalized.split('.');
  return BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
}

export function formatMoney(cents: number | bigint, currency = 'EUR', locale = 'it-IT'): string {
  if (typeof cents === 'number' && !Number.isSafeInteger(cents))
    throw new Error('Importo non valido.');
  const value = BigInt(cents);
  const whole = value / 100n;
  const fraction = (value < 0n ? -value : value) % 100n;
  // Formatting the integer part as BigInt avoids rounding a cent away near Number.MAX_SAFE_INTEGER.
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .formatToParts(value < 0n && whole === 0n ? -0 : whole)
    .map((part) => (part.type === 'fraction' ? fraction.toString().padStart(2, '0') : part.value))
    .join('');
}

export function splitEqually(cents: bigint, parts: number): bigint[] {
  if (cents < 0n || !Number.isInteger(parts) || parts < 1 || parts > 1000)
    throw new Error('Divisione non valida.');
  const count = BigInt(parts);
  return Array.from(
    { length: parts },
    (_, index) => cents / count + (BigInt(index) < cents % count ? 1n : 0n),
  );
}

export function percentageDiscount(cents: bigint, basisPoints: number): bigint {
  if (cents < 0n || !Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000)
    throw new Error('Sconto non valido.');
  return (cents * BigInt(basisPoints) + 5000n) / 10000n;
}
