import { cn } from '../../lib/cn';

export interface DistSegment {
  label: string;
  value: number;
  color: string;
}

/**
 * Full-width segmented heat-ramp bar (reference Ops-Head "SLA Bucket Distribution"). Pure CSS — no
 * chart library needed.
 */
export function DistributionBar({
  segments,
  className,
  testId,
}: {
  segments: DistSegment[];
  className?: string;
  testId?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className={className} data-testid={testId}>
      {/* A 2px surface gap between adjacent fills: without it two neighbouring ramp steps read as one
          longer segment, which is exactly the misreading an ordinal ramp invites. Zero-value segments
          are dropped so they cannot contribute a stray gap of their own. */}
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-surface-sunken">
        {segments.filter((s) => s.value > 0).map((s, i) => (
          <div
            key={i}
            title={`${s.label}: ${s.value}`}
            className="first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(100 * s.value) / total}%`, background: s.color }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments.map((s, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-full')} style={{ background: s.color }} />
            <span className="text-ink-muted">{s.label}</span>
            <span className="font-medium text-ink-strong">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
