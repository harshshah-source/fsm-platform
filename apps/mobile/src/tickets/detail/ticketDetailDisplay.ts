// Mirrors apps/admin/src/lib/inactiveDuration.ts's formatInactiveDuration (not shared cross-package
// yet — small, stable, leaf formatting logic; a future consolidation into @fsm/shared is reasonable
// but out of scope here). Two-unit max, e.g. "20m", "39h 30m", "3d 6h".
export function formatInactiveDuration(sinceIso: string | null | undefined, now: Date = new Date()): string | null {
  if (!sinceIso) return null;
  const then = new Date(sinceIso).getTime();
  if (Number.isNaN(then)) return null;
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
