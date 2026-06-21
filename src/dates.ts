// Relative-date convenience. Tools accept `last_n_days` so callers can say "last 15 days"
// without computing ISO dates. Returns a new params object with date_from/date_to filled
// (explicit date_from/date_to always win) and last_n_days stripped.
export function applyRelativeWindow(args: Record<string, any>): Record<string, any> {
  const { last_n_days, ...rest } = args;
  if (last_n_days === undefined || last_n_days === null) return rest;
  const n = Number(last_n_days);
  if (!Number.isFinite(n) || n <= 0) return rest;
  const now = new Date();
  const toIso = (d: Date) => d.toISOString().slice(0, 10); // YYYY-MM-DD
  const from = new Date(now.getTime() - n * 86_400_000);
  return {
    ...rest,
    date_from: rest.date_from ?? toIso(from),
    date_to: rest.date_to ?? toIso(now),
  };
}
