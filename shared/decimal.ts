/** Exact commercial decimals. BigInt never leaves this module or enters JSON. */
function parse(raw: string): { canonical: string; coefficient: bigint; scale: number } {
  if (typeof raw !== 'string') throw new Error('Enter a nonnegative decimal amount.');
  const text = raw.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error('Enter a nonnegative decimal amount without exponent notation.');
  const [integer = '', fraction = ''] = text.split('.');
  const whole = (integer || '0').replace(/^0+(?=\d)/, '');
  const canonical = fraction ? `${whole}.${fraction}` : whole;
  return { canonical, coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

export function normalizeDecimal(raw: string): string { return parse(raw).canonical; }
export function compareDecimals(left: string, right: string): -1 | 0 | 1 {
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  const x = a.coefficient * 10n ** BigInt(scale - a.scale);
  const y = b.coefficient * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function decimalsEqual(left: string, right: string): boolean { return compareDecimals(left, right) === 0; }
