import type { ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { CHART_PALETTE } from './colors';

export interface DonutDatum {
  name: string;
  value: number;
  color?: string;
}

/** Donut/proportion chart with an optional centre overlay (reference verification outcomes / workload). */
export function DonutChart({
  data,
  height = 220,
  center,
}: {
  data: DonutDatum[];
  height?: number;
  center?: ReactNode;
}) {
  const hasData = data.some((d) => d.value > 0);
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            outerRadius="88%"
            paddingAngle={2}
            stroke="none"
          >
            {data.map((d, i) => (
              <Cell key={i} fill={d.color ?? CHART_PALETTE[i % CHART_PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
      {center && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {center}
        </div>
      )}
      {!hasData && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted">
          No data
        </div>
      )}
    </div>
  );
}

/** Legend list for categorical charts (colour swatch + name + value). */
export function ChartLegend({
  items,
}: {
  items: { name: string; value: number; color?: string }[];
}) {
  return (
    <ul className="space-y-1.5 text-xs">
      {items.map((it, i) => (
        <li key={i} className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: it.color ?? CHART_PALETTE[i % CHART_PALETTE.length] }}
          />
          <span className="text-ink-muted">{it.name}</span>
          <span className="ml-auto font-medium text-ink-strong">{it.value}</span>
        </li>
      ))}
    </ul>
  );
}
