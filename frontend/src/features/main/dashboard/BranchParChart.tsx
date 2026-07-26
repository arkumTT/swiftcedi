import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, LabelList } from 'recharts';

export interface BranchParPoint {
  branchName: string;
  par30Ratio: number; // 0..1
}

function toneFor(ratio: number): string {
  if (ratio >= 0.1) return 'var(--color-danger)';
  if (ratio >= 0.05) return 'var(--color-warning)';
  return 'var(--color-success)';
}

/**
 * Branch PAR30 comparison (Section 7.4) — a magnitude-per-category
 * comparison, colored by risk threshold (>=10% danger, >=5% warning,
 * else success) rather than one flat categorical hue, since the whole
 * point of the chart is which branches are at risk. Data labels print
 * the percentage directly so color is never the only signal.
 */
export function BranchParChart({ data }: { data: BranchParPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 20, right: 12, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="branchName" tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} axisLine={{ stroke: 'var(--color-border)' }} tickLine={false} />
        <YAxis
          domain={[0, (max: number) => Math.max(max * 1.2, 0.1)]}
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip
          formatter={(value) => `${(Number(value) * 100).toFixed(1)}%`}
          contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
        />
        <Bar dataKey="par30Ratio" radius={[4, 4, 0, 0]} maxBarSize={48}>
          <LabelList dataKey="par30Ratio" position="top" formatter={(v: unknown) => `${(Number(v) * 100).toFixed(1)}%`} style={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
          {data.map((d, i) => (
            <Cell key={i} fill={toneFor(d.par30Ratio)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
