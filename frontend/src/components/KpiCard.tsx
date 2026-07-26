import type { ReactNode } from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import clsx from 'clsx';

interface KpiCardProps {
  label: string;
  value: ReactNode;
  delta?: { value: number; period?: string };
  /** true = an increase is good (revenue); false = an increase is bad (PAR/arrears). Flips delta coloring. */
  higherIsBetter?: boolean;
  icon?: ReactNode;
}

export function KpiCard({ label, value, delta, higherIsBetter = true, icon }: KpiCardProps) {
  const isUp = (delta?.value ?? 0) >= 0;
  const isGood = higherIsBetter ? isUp : !isUp;

  return (
    <div className="rounded-card border border-border bg-surface p-[var(--card-padding)] shadow-[var(--shadow-elevation)]">
      <div className="flex items-start justify-between">
        <span className="text-[11.5px] font-semibold tracking-wide text-text-secondary uppercase">{label}</span>
        {icon && <span className="text-text-muted">{icon}</span>}
      </div>
      <div className="tabular-nums mt-2 text-xl font-semibold text-text-primary">{value}</div>
      {delta && (
        <div
          className={clsx(
            'mt-1.5 flex items-center gap-1 text-[12.5px] font-medium',
            isGood ? 'text-success' : 'text-danger'
          )}
        >
          {isUp ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          <span className="tabular-nums">{Math.abs(delta.value).toFixed(1)}%</span>
          {delta.period && <span className="font-normal text-text-muted">{delta.period}</span>}
        </div>
      )}
    </div>
  );
}
