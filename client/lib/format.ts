/** Presentation only: numeric controls, reviews and saved values retain precision. */
export const formatRadiusKm = (value: number): string => value.toLocaleString(undefined, { maximumFractionDigits: 3 });
