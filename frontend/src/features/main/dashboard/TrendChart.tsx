import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Legend } from 'recharts';
import { formatGhs } from '../../../lib/format';

export interface TrendPoint {
  period: string;
  disbursedPesewas: number;
  collectedPesewas: number;
}

/**
 * Disbursement-vs-collection trend (Section 7.4). One shared Y axis (both
 * series are pesewas amounts) — never a dual-axis chart. Fixed categorical
 * order: primary (disbursements) then accent (collections), matching the
 * brand pair used everywhere else rather than an arbitrary chart palette.
 */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="period" tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} axisLine={{ stroke: 'var(--color-border)' }} tickLine={false} />
        <YAxis
          tickFormatter={(v) => `${(v / 100_00_00).toFixed(0)}k`}
          tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }}
          axisLine={false}
          tickLine={false}
          width={46}
        />
        <Tooltip
          formatter={(value) => formatGhs(Number(value))}
          contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="disbursedPesewas" name="Disbursed" stroke="var(--color-primary)" strokeWidth={2} dot={{ r: 3 }} />
        <Line type="monotone" dataKey="collectedPesewas" name="Collected" stroke="var(--color-accent)" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
