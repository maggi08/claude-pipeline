export function baseRateCents(weightKg) {
  return 500 + Math.ceil(weightKg) * 120
}
