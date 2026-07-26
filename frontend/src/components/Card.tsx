import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
}

export function Card({ title, actions, padded = true, className, children, ...props }: CardProps) {
  return (
    <div
      className={clsx('rounded-card border border-border bg-surface shadow-[var(--shadow-elevation)]', className)}
      {...props}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          {title && <h2 className="text-[15px] font-semibold text-text-primary">{title}</h2>}
          {actions}
        </div>
      )}
      <div className={padded ? 'p-[var(--card-padding)]' : undefined}>{children}</div>
    </div>
  );
}
