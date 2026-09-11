import type { ReactNode } from 'react';

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5 10 3 3 7-7" />
    </svg>
  );
}

export function AuthLayout({
  eyebrow,
  title,
  description,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="auth-layout">
      <aside className="auth-story" aria-label="About djobi">
        <div className="auth-story__glow" />
        <p className="auth-story__eyebrow">A calmer job search</p>
        <h2>Keep every opportunity moving forward.</h2>
        <p className="auth-story__copy">
          Tailor your materials, save the context, and learn from every application in one focused
          workspace.
        </p>

        <div className="auth-story__preview" aria-hidden="true">
          <div className="auth-story__preview-head">
            <span>Your pipeline</span>
            <span>12 applications</span>
          </div>
          <div className="auth-story__stages">
            <span className="auth-story__stage auth-story__stage--applied">Applied</span>
            <span className="auth-story__stage auth-story__stage--screen">Screen</span>
            <span className="auth-story__stage auth-story__stage--onsite">Onsite</span>
          </div>
          <div className="auth-story__application">
            <span className="auth-story__company">L</span>
            <span>
              <strong>Product Engineer</strong>
              <small>Linear</small>
            </span>
            <i />
          </div>
          <div className="auth-story__application">
            <span className="auth-story__company auth-story__company--violet">A</span>
            <span>
              <strong>Frontend Engineer</strong>
              <small>Anthropic</small>
            </span>
            <i className="is-violet" />
          </div>
        </div>

        <p className="auth-story__note">
          <CheckIcon /> You stay in control. djobi never submits an application for you.
        </p>
      </aside>

      <section className="login" aria-labelledby="auth-title">
        <p className="auth-eyebrow">{eyebrow}</p>
        <h1 id="auth-title">{title}</h1>
        <p className="auth-description">{description}</p>
        {children}
        <div className="login-alt">{footer}</div>
      </section>
    </div>
  );
}
