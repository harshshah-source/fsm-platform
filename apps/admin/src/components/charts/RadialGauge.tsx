import type { ReactNode } from 'react';
import { PolarAngleAxis, RadialBar, RadialBarChart, ResponsiveContainer } from 'recharts';
import { CHART } from './colors';

/** Single-value radial gauge with a centre percentage (reference plant workload / utilization). */
export function RadialGauge({
  value,
  height = 180,
  color = CHART.success,
  label,
}: {
  value: number;
  height?: number;
  color?: string;
  label?: ReactNode;
}) {
  const data = [{ value }];
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          innerRadius="72%"
          outerRadius="100%"
          data={data}
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
          <RadialBar
            dataKey="value"
            cornerRadius={8}
            fill={color}
            background={{ fill: CHART.grid }}
            angleAxisId={0}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold text-ink-strong">{value}%</span>
        {label && <span className="text-[11px] text-ink-muted">{label}</span>}
      </div>
    </div>
  );
}
