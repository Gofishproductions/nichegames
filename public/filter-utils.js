export function createdWindowMs(value, unit) {
  if (unit === 'all') return Number.POSITIVE_INFINITY;
  const amount = Math.max(1, Number(value) || 30);
  const units = {
    hours: 3_600_000,
    days: 86_400_000,
    weeks: 604_800_000,
    months: 2_629_746_000,
    years: 31_556_952_000,
  };
  return amount * (units[unit] || units.days);
}

export function isWithinCreatedWindow(created, value, unit, now = Date.now()) {
  if (!created) return false;
  const createdAt = new Date(created).getTime();
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  const age = now - createdAt;
  return age >= 0 && (unit === 'all' || age <= createdWindowMs(value, unit));
}
