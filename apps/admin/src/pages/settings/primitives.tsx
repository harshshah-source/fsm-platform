import type { FormEvent, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * The shared vocabulary every Settings section is built from.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **One surface per data set, never one per setting.** A settings console that wraps each control
 *     in its own card reads as a pile of unrelated widgets. Hierarchy comes from typography, a
 *     hairline and vertical rhythm instead.
 *  2. **The things that belong to one data set live inside one box.** The "add a record" strip is a
 *     *band of its table's panel*, not a second card floating above it — an operator reads
 *     "companies" as one object with a way in at the top, rather than as two stacked surfaces that
 *     happen to be adjacent. Same for a read-only fact strip under a control: it is the panel's
 *     footer, because it describes what the control above it just did.
 *
 * Everything here is presentation; no section owns a different heading size, label style, table
 * header, skeleton or empty state than its neighbours.
 */

/** Section shell — title, one-line purpose, optional right-hand meta, then the body on a rhythm. */
export function SettingsSection({
  title,
  description,
  meta,
  children,
}: {
  title: string;
  description: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      {/* No rule under the header: the first panel's own border is a line 24px below it, and two
          hairlines that close together read as a boxed banner rather than as a heading. */}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 pb-6">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold tracking-tight text-ink-strong">{title}</h3>
          <p className="mt-1.5 max-w-[68ch] text-sm leading-6 text-ink-muted">{description}</p>
        </div>
        {meta && <div className="flex shrink-0 items-center gap-2 pt-1">{meta}</div>}
      </div>
      <div className="flex flex-col gap-8">{children}</div>
    </section>
  );
}

/** Heading for a block *within* a section (a section may hold two related data sets, no more). */
export function SubHeading({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3.5">
      <h4 className="text-sm font-semibold text-ink-strong">{children}</h4>
      {hint && <p className="mt-1 max-w-[68ch] text-sm leading-6 text-ink-muted">{hint}</p>}
    </div>
  );
}

/**
 * Label + control. Deliberately a wrapping `<label>`: the association survives with no id plumbing,
 * which is what keeps a dozen small forms accessible without a dozen unique ids to maintain.
 */
export function Field({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex w-full min-w-0 flex-col gap-1.5 sm:w-52', className)}>
      <span className="text-xs font-semibold text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

/**
 * The one bordered surface a section is allowed. Everything that belongs to a single data set —
 * the way to add to it, the records themselves, the facts about it — sits inside one of these.
 */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-card border border-line bg-surface-card shadow-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A quiet band inside a {@link Panel} — the entry strip at the top, the fact strip at the bottom.
 * Tinted one step off the card so it reads as chrome around the data rather than as data.
 */
export function PanelBand({
  className,
  position = 'top',
  children,
}: {
  className?: string;
  /** `top` draws its hairline below itself, `bottom` above — so the band never doubles a border. */
  position?: 'top' | 'bottom';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'bg-surface-raised',
        position === 'top' ? 'border-b border-line' : 'border-t border-line',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The "add a record" strip. Lives as the top band of its table's panel — a bare row of inputs
 * floating above a table is indistinguishable from the table's own filters, and a *second card*
 * above the table doubles the surface count for no gain.
 */
export function EntryForm({
  legend,
  onSubmit,
  action,
  children,
}: {
  legend: string;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} aria-label={legend} className="px-4 py-4 sm:px-5">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-caps">{legend}</p>
      {/* A wider gap down the cross axis than across it: when the row wraps, the second line has to
          read as a continuation of the same form rather than as a second one. */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-4">
        {children}
        <div className="w-full sm:w-auto">{action}</div>
      </div>
    </form>
  );
}

export interface TableHeader {
  label: ReactNode;
  /** `center` is for matrix columns — a grid of marks reads down its own axis, not off an edge. */
  align?: 'left' | 'center' | 'right';
  /** Hide on narrow viewports — used for columns that are context rather than identity. */
  hideBelow?: 'sm' | 'md';
}

const headerAlign = (h: TableHeader) =>
  h.align === 'right' ? 'text-right' : h.align === 'center' ? 'text-center' : 'text-left';
const hideClass = (h: TableHeader) =>
  h.hideBelow === 'sm' ? 'hidden sm:table-cell' : h.hideBelow === 'md' ? 'hidden md:table-cell' : '';

/** Cell classes, exported so bespoke rows (inline edit) stay identical to generated ones. */
export const cellClass = 'px-4 py-2.5 align-middle text-ink';
export const cellRightClass = 'px-4 py-2.5 text-right align-middle tabular-nums text-ink';
export const rowClass = 'border-b border-line last:border-b-0';

/**
 * A table of records, inside the one surface its section is allowed. Holds the optional entry band,
 * the header, horizontal overflow (so a wide table scrolls inside its own box and never the page),
 * and the single shared skeleton / empty state.
 *
 * Loading renders as ghost rows rather than the word "Loading…": the table keeps the height and
 * column rhythm it is about to have, so arriving data does not shove the page. `aria-busy` carries
 * the same fact to assistive tech, which is why the ghosts themselves are hidden from it.
 */
export function TablePanel({
  ariaLabel,
  headers,
  rowCount,
  loading = false,
  emptyMessage,
  emptyHint,
  toolbar,
  children,
}: {
  ariaLabel: string;
  headers: TableHeader[];
  rowCount: number;
  loading?: boolean;
  emptyMessage: string;
  /** One quiet line under the empty message — what to do about it. */
  emptyHint?: string;
  /** The entry strip, rendered as the panel's top band. */
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel>
      {toolbar && <PanelBand>{toolbar}</PanelBand>}
      <div className="overflow-x-auto">
        <table aria-label={ariaLabel} aria-busy={loading} className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-chrome-700 bg-chrome-900">
              {headers.map((h, i) => (
                <th
                  key={i}
                  scope="col"
                  className={cn('px-4 py-2.5 text-white', headerAlign(h), hideClass(h))}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows headers={headers} />
            ) : rowCount === 0 ? (
              <tr>
                <td colSpan={headers.length} className="px-4 py-14 text-center">
                  <span className="block text-sm text-ink">{emptyMessage}</span>
                  {emptyHint && <span className="mt-1 block text-xs text-ink-muted">{emptyHint}</span>}
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** Ghost rows for a table that is still loading. Decorative — the table carries `aria-busy`. */
function SkeletonRows({ headers }: { headers: TableHeader[] }) {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <tr key={row} aria-hidden className={rowClass}>
          {headers.map((h, i) => (
            <td key={i} className={cn(cellClass, hideClass(h))}>
              <span
                className={cn(
                  'block h-3 animate-pulse rounded-full bg-line',
                  i === 0 ? 'w-32' : 'w-16',
                  h.align === 'right' && 'ml-auto',
                  h.align === 'center' && 'mx-auto',
                )}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

const NOTICE_TONES = {
  critical: 'border-critical/30 bg-critical-bg text-critical',
  success: 'border-success/30 bg-success-bg text-success',
  warning: 'border-warning/30 bg-warning-bg text-warning',
  neutral: 'border-line bg-surface-raised text-ink',
} as const;

/**
 * Inline notice. A failure defaults to `role="alert"` so a refusal is announced rather than merely
 * coloured; a standing informational banner takes no live role, because re-announcing "editable by…"
 * on every render is noise, not help.
 */
export function Notice({
  tone,
  className,
  children,
  ...rest
}: {
  tone: keyof typeof NOTICE_TONES;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  return (
    <div
      role={tone === 'critical' ? 'alert' : undefined}
      className={cn(
        'rounded-md border px-3.5 py-2.5 text-sm leading-6',
        NOTICE_TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * A read-only fact strip — what is actually in force, beneath the control that sets it. Label above
 * value rather than beside it: the values are short and unrelated to each other, so a column of
 * left-aligned terms would spend a whole column on words the operator reads once.
 */
export function FactList({ items }: { items: { term: string; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-10 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <div key={it.term} className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
            {it.term}
          </dt>
          <dd className="mt-1 text-sm leading-6 text-ink-strong">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
