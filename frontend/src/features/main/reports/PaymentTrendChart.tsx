import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { formatGhs } from '../../../lib/format';

export interface PaymentTrendPoint {
  period: string;
  totalPesewas: number;
}

// Same compact-notation Y-axis approach as dashboard/TrendChart.tsx — a
// fixed divisor collapses to "0k" for a microfinance institution's
// typical daily repayment volumes.
const ghsCompactFormatter = new Intl.NumberFormat('en-GH', { notation: 'compact', maximumFractionDigits: 1 });

/** Single-series repayment total trend (item 2's "simple trend view"). One series needs no legend — the card title already names it. */
export function PaymentTrendChart({ data }: { data: PaymentTrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="period" tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} axisLine={{ stroke: 'var(--color-border)' }} tickLine={false} />
        <YAxis
          tickFormatter={(v) => `GH₵${ghsCompactFormatter.format(v / 100)}`}
          tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }}
          axisLine={false}
          tickLine={false}
          width={58}
        />
        <Tooltip
          formatter={(value) => formatGhs(Number(value))}
          contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
        />
        <Line type="monotone" dataKey="totalPesewas" name="Collected" stroke="var(--color-primary)" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
