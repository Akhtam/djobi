/**
 * The sign-in view for the options page — `docs/multi-tenant-auth.md` Phase D.
 *
 * Email/password only, the same reasoning `apps/dashboard`'s `Login` gives: Better Auth is
 * configured for it. No sign-up form here — an account is created via the dashboard's public
 * sign-up flow (`docs/multi-tenant-auth.md`), not from the extension.
 */
import { useState, type FormEvent } from 'react';
import icon48 from '../assets/icons/icon48.png';

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
      // No `finally`-set `submitting(false)` on success: `onSignIn` replaces this view with the
      // profile editor once it resolves, so this component unmounts. The `catch` below is the only
      // path that leaves it mounted.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setSubmitting(false);
    }
  }

  return (
    <main className="page page-loading">
      <div className="login-card">
        <div className="brand">
          <img src={icon48} alt="" className="brand-mark" />
          <div>
            <h1>djobi</h1>
            <p className="subtitle">Sign in</p>
          </div>
        </div>

        {error ? (
          <p className="status-pill error" role="alert">
            {error}
          </p>
        ) : null}

        <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
