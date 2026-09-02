/**
 * The sign-in view — `#/login`, `docs/multi-tenant-auth.md` Phase C.
 *
 * Email/password only: Better Auth is configured for it (`apps/backend/src/auth.ts`), and neither
 * Google nor GitHub has real credentials registered yet. `SignUp.tsx` (`#/signup`) is the
 * counterpart — signup is public now, not an operator-only action.
 */
import { useState, type FormEvent } from 'react';
import { failureMessage } from '@djobi/shared';
import { signUpPath } from '../lib/useHashRoute';

export function Login({
  onSignIn,
}: {
  onSignIn: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSignIn(email, password);
      // No `finally`-set `submitting(false)` on the success path: `onSignIn` navigates away on
      // success, and this component unmounts. Setting state after that would be a no-op React
      // would warn about; the `catch` below is the only path that leaves this view mounted.
    } catch (err) {
      setError(failureMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      <h1>Sign in</h1>

      {error ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}

      <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
        <label className="login-field">
          Email
          <input
            type="email"
            className="search"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="login-field">
          Password
          <input
            type="password"
            className="search"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <button type="submit" className="button button--primary" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="login-alt">
        Don’t have an account? <a href={signUpPath()}>Create one</a>
      </p>
    </div>
  );
}
