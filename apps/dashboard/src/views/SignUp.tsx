/**
 * The sign-up view — `#/signup`, `docs/multi-tenant-auth.md` Phase C (public signup).
 *
 * Email/password only, matching `Login`: Better Auth is configured for it (`apps/backend/src/
 * auth.ts`), and neither Google nor GitHub has real credentials registered yet.
 */
import { useState, type FormEvent } from 'react';
import { failureMessage, SignUpRequestSchema } from '@djobi/shared';
import { loginPath } from '../lib/useHashRoute';

export function SignUp({
  onSignUp,
}: {
  onSignUp: (email: string, password: string, name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    // Validated client-side against the same schema the backend enforces (`SignUpRequestSchema`),
    // so a too-short password is rejected here rather than round-tripping for a 400.
    const parsed = SignUpRequestSchema.safeParse({ email, password, name });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the fields above.');
      setSubmitting(false);
      return;
    }

    try {
      await onSignUp(email, password, name);
      // No `finally`-set `submitting(false)` on the success path — see `Login.tsx`'s identical note.
    } catch (err) {
      setError(failureMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      <h1>Create an account</h1>

      {error ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}

      <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
        <label className="login-field">
          Name
          <input
            type="text"
            className="search"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

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
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <button type="submit" className="button button--primary" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="login-alt">
        Already have an account? <a href={loginPath()}>Sign in</a>
      </p>
    </div>
  );
}
