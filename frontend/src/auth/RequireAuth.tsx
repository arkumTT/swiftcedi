import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex min-h-svh items-center justify-center bg-page-bg text-text-secondary text-sm">
        Loading…
      </div>
    );
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

/** Gates a route/element behind one of several permission codes — a 403-style inline message, never a silent redirect, so staff understand why access is denied. */
export function RequirePermission({ anyOf, children }: { anyOf: string[]; children: ReactNode }) {
  const { hasAnyPermission } = useAuth();
  if (!hasAnyPermission(anyOf)) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
        <p className="font-medium text-text-primary">You don't have access to this screen</p>
        <p className="max-w-sm text-[13px] text-text-secondary">
          Ask a system administrator to grant the required permission if you believe this is a mistake.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
