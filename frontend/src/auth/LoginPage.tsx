import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Landmark } from 'lucide-react';
import { useAuth } from './AuthContext';
import { Button } from '../components/Button';
import { FormField, inputClasses } from '../components/FormField';
import { ApiError } from '../lib/apiClient';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-page-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex size-11 items-center justify-center rounded-card bg-primary text-white">
            <Landmark size={22} aria-hidden="true" />
          </span>
          <h1 className="text-xl font-semibold text-text-primary">SwiftCedi</h1>
          <p className="text-[13px] text-text-secondary">Sign in to the banking platform</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6 shadow-[var(--shadow-elevation)]"
        >
          <FormField label="Email">
            {(id) => (
              <input
                id={id}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClasses}
              />
            )}
          </FormField>
          <FormField label="Password">
            {(id) => (
              <input
                id={id}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClasses}
              />
            )}
          </FormField>

          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" disabled={submitting} className="mt-1 w-full">
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
