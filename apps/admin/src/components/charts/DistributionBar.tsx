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
}: {
  segments: DistSegment[];
  className?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className={className}>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken">
        {segments.map((s, i) => (
          <div
            key={i}
            title={`${s.label}: ${s.value}`}
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
