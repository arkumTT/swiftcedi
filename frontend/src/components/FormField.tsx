import { useId, type ReactNode } from 'react';
import clsx from 'clsx';

interface FormFieldProps {
  label: string;
  error?: string;
  children: (id: string) => ReactNode;
  hint?: string;
}

/** Associates every input with its label via id/htmlFor (Section 4 — real <label>, never a styled div). */
export function FormField({ label, error, children, hint }: FormFieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-medium text-text-primary">
        {label}
      </label>
      {children(id)}
      {hint && !error && <span className="text-[12px] text-text-muted">{hint}</span>}
      {error && (
        <span role="alert" className="text-[12px] text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

export const inputClasses = clsx(
  'h-9 rounded-md border border-border bg-surface px-3 text-sm text-text-primary',
  'focus-visible:border-accent'
);

export const selectClasses = inputClasses;
export const textareaClasses = clsx(inputClasses, 'h-auto py-2');
