import { AlertOctagon } from 'lucide-react';
import { Button } from './Button';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <span className="text-danger">
        <AlertOctagon size={28} aria-hidden="true" />
      </span>
      <p className="font-medium text-text-primary">Something went wrong</p>
      <p className="max-w-sm text-[13px] text-text-secondary">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
