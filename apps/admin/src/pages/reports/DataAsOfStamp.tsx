import type { ReactNode } from 'react';
import { NO_CUBE_LABEL, REPORT_STALE_AFTER_HOURS, reportAgeLabel, reportFreshness } from '../../api/reports';

/**
 * The "Data as of" stamp every report surface carries (#347), and the header band it sits in.
 *
 * The stamp answers one question: **is the number in front of me current?** It answers it from the
 * report's own `dataAsOf` — the cube's `computed_at` — and never from the browser clock. The page
 * used to stamp `new Date()` when its fetch resolved, which looks identical to a real answer and is
 * not one: it agreed with the wall clock whatever the state of the cube behind it, so a scheduler
 * dead for two days still printed this morning over two-day-old numbers, and a manager acted on them.
 *
 * Three states, because there are three things that can be true — the cube is current, the cube has
 * not been rebuilt within {@link REPORT_STALE_AFTER_HOURS}, or there is no cube row at all. The third
 * is a normal state, not an error: a report defaults to the current month/day, and a window the sweep
 * has not reached simply has nothing computed in it yet. It says so in words rather than showing a
 * blank where a timestamp goes, because a missing stamp reads as "fine" (see #346's `null` uptime —
 * the same reasoning, one layer down).
 */
export function DataAsOfStamp({
  dataAsOf,
  loading = false,
  testId,
}: {
  dataAsOf: string | null | undefined;
  /** The report has not arrived yet — distinct from "it arrived carrying no stamp". */
  loading?: boolean;
  testId: string;
}) {
  if (loading) {
    return (
      <span data-testid={testId} data-freshness="loading" className={`${PILL} border-line text-ink-muted`}>
        Loading…
      </span>
    );
  }

  const f = reportFreshness(dataAsOf);
  const tone =
    f.state === 'stale'
      ? 'border-warning/40 bg-warning-bg text-warning'
      : f.state === 'missing'
        ? 'border-dashed border-line text-ink-muted'
        : 'border-line text-ink-muted';

  return (
    <span
      data-testid={testId}
      data-freshness={f.state}
      title={
        f.state === 'missing'
          ? 'No summary row has been computed for this window yet.'
          : `Computed ${reportAgeLabel(f.ageMs ?? 0)}. Stale past ${REPORT_STALE_AFTER_HOURS}h without a rebuild.`
      }
      className={`${PILL} ${tone}`}
    >
      <span aria-hidden="true">🗓</span>
      {f.state === 'missing' ? NO_CUBE_LABEL : f.label}
      {f.state === 'stale' && (
        <span className="rounded-sm bg-warning/15 px-1 py-px font-bold uppercase tracking-wider">
          Stale · {reportAgeLabel(f.ageMs ?? 0)}
        </span>
      )}
    </span>
  );
}

const PILL =
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide';

/**
 * The reference header band (refs 21 / 23 / 24 / 25): scope chips on the left, the freshness stamp
 * with them. One component so the four report pages carry the same band rather than four near-copies
 * that drift — the stamp is the only thing on it that has to be identical everywhere.
 */
export function ReportMetaStrip({
  dataAsOf,
  loading = false,
  stampTestId,
  testId,
  children,
}: {
  dataAsOf: string | null | undefined;
  loading?: boolean;
  stampTestId: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-card px-3 py-2 text-xs"
    >
      {children}
      <DataAsOfStamp dataAsOf={dataAsOf} loading={loading} testId={stampTestId} />
    </div>
  );
}
