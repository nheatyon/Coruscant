/** Lookup normalization identifies a reference; it confers no access. */
export function normalizeReference(value: string): string {
  return value.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
