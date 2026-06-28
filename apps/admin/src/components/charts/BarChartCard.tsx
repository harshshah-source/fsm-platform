import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART } from './colors';

export interface BarDatum {
  name: string;
  value: number;
  color?: string;
}

/** Horizontal bar chart (reference "Inactivity by SLA bucket" / root-cause distribution). */
export function BarChartCard({
  data,
  height = 240,
  color = CHART.brand,
  categoryWidth = 120,
}: {
  data: BarDatum[];
  height?: number;
  color?: string;
  categoryWidth?: number;
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart layout="vertical" data={data} margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="name"
            width={categoryWidth}
            tick={{ fontSize: 11, fill: CHART.axis }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip cursor={{ fill: 'rgba(15,20,34,0.04)' }} />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={14}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.color ?? color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
