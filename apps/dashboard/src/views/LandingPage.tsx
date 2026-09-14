import { useEffect, useState } from 'react';
import logoUrl from '../assets/icons/djobi-icon.svg';
import { ThemeToggle, useThemePreference } from '../lib/theme';

const DASHBOARD_PATH = '/#/';

const PREVIEW_APPLICATIONS = [
  {
    company: 'Anthropic',
    role: 'Member of Technical Staff, Product',
    source: 'Manual',
    sourceKind: 'manual',
    stage: 'Rejected (ATS)',
    stageKind: 'rejected',
    date: 'Mar 19, 2026',
  },
  {
    company: 'Linear',
    role: 'Frontend Engineer',
    source: 'Ashby',
    sourceKind: 'ashby',
    stage: 'Applied',
    stageKind: 'applied',
    date: 'Mar 16, 2026',
  },
  {
    company: 'Brex',
    role: 'Senior Frontend Engineer',
    source: 'Greenhouse',
    sourceKind: 'greenhouse',
    stage: 'Onsite',
    stageKind: 'onsite',
    date: 'Mar 14, 2026',
  },
  {
    company: 'Sonar',
    role: 'Staff Engineer, Platform',
    source: 'Lever',
    sourceKind: 'lever',
    stage: 'Applied',
    stageKind: 'applied',
    date: 'Mar 11, 2026',
  },
] as const;

const PREVIEW_SLIDES = ['Applications', 'Application detail', 'Analytics'] as const;
type PreviewSlide = (typeof PREVIEW_SLIDES)[number];
const PREVIEW_DESCRIPTIONS: Record<PreviewSlide, string> = {
  Applications: 'Search, filter, and move every application through your pipeline.',
  'Application detail': "Review one role's context, requirements, materials, and notes.",
  Analytics: 'Spot recurring keywords, evidence gaps, and response trends.',
};

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5 10 3 3 7-7" />
    </svg>
  );
}

function PreviewAppBar({ active }: { active: 'applications' | 'analytics' | null }) {
  return (
    <div className="landing-window__appbar">
      <div className="landing-window__brand">
        <img src={logoUrl} alt="" width={18} height={18} />
        <span>djobi</span>
      </div>
      <div className="landing-window__nav">
        <span className={active === 'applications' ? 'is-active' : ''}>Applications</span>
        <span className={active === 'analytics' ? 'is-active' : ''}>Analytics</span>
      </div>
      <div className="landing-window__account">
        <span className="landing-window__theme">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        </span>
        <span className="landing-window__avatar">A</span>
      </div>
    </div>
  );
}

function ApplicationsPreview() {
  return (
    <>
      <PreviewAppBar active="applications" />
      <div className="landing-window__body">
        <div className="landing-window__heading">
          <div>
            <strong>Applications</strong>
            <span>8 applications · 4 in progress</span>
          </div>
          <span className="landing-window__log">
            <svg viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Log application
          </span>
        </div>

        <div className="landing-window__controls">
          <span className="landing-window__search">
            <svg viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7" />
              <path d="m16.5 16.5 4 4" />
            </svg>
            Search company or role…
          </span>
          <div className="landing-stage-row">
            <span className="is-active">All 8</span>
            <span>Applied 2</span>
            <span>Phone screen 1</span>
            <span>Onsite 2</span>
            <span>Offer 1</span>
            <span>Rejected 2</span>
          </div>
        </div>

        <div className="landing-demo-table-wrap">
          <table className="landing-demo-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Posting</th>
                <th>Role</th>
                <th>Source</th>
                <th>Status</th>
                <th>Applied</th>
              </tr>
            </thead>
            <tbody>
              {PREVIEW_APPLICATIONS.map((application) => (
                <tr key={application.company}>
                  <td className="landing-demo-table__company">{application.company}</td>
                  <td>
                    <span className="landing-demo-table__posting">
                      Job posting
                      <svg viewBox="0 0 24 24">
                        <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                      </svg>
                    </span>
                  </td>
                  <td className="landing-demo-table__role">{application.role}</td>
                  <td>
                    <span
                      className={`landing-demo-table__source landing-demo-table__source--${application.sourceKind}`}
                    >
                      {application.source}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`landing-demo-stage landing-demo-stage--${application.stageKind}`}
                    >
                      {application.stage}
                      <svg viewBox="0 0 24 24">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </span>
                  </td>
                  <td className="landing-demo-table__date">{application.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function ApplicationDetailPreview() {
  return (
    <>
      <PreviewAppBar active={null} />
      <div className="landing-window__body landing-detail-demo">
        <span className="landing-detail-demo__back">← Applications</span>
        <div className="landing-detail-demo__header">
          <div>
            <strong>Brex · Infrastructure · Remote (US)</strong>
            <span>Senior Frontend Engineer</span>
            <span className="landing-demo-table__posting">Job posting ↗</span>
          </div>
          <div className="landing-detail-demo__status">
            <span>Saved Mar 14, 2026</span>
            <span className="landing-demo-stage landing-demo-stage--onsite">
              Onsite
              <svg viewBox="0 0 24 24">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </div>
        </div>
        <div className="landing-detail-demo__tabs">
          <span className="is-active">Job info</span>
          <span>Posting</span>
          <span>Materials</span>
          <span>Notes</span>
        </div>
        <div className="landing-detail-demo__panel">
          <div className="landing-detail-demo__fact">
            <span>Seniority</span>
            <strong>Senior</strong>
          </div>
          <h3>Requirements</h3>
          <div className="landing-detail-demo__requirements">
            <div>
              <span className="is-critical">Critical</span>
              <p>5+ years building production React applications</p>
              <small>Evidenced in experience · 5+ yrs</small>
            </div>
            <div>
              <span className="is-high">High</span>
              <p>Experience improving frontend performance at scale</p>
              <small>Evidenced in experience</small>
            </div>
            <div>
              <span>Preferred</span>
              <p>Experience with design systems at scale</p>
              <small>Evidenced in skills</small>
            </div>
          </div>
          <h3>Keywords</h3>
          <div className="landing-detail-demo__tags">
            <span>React · Framework</span>
            <span>TypeScript · Language</span>
            <span>GraphQL · Tool</span>
          </div>
        </div>
      </div>
    </>
  );
}

function AnalyticsPreview() {
  const keywords = [
    ['TypeScript', 'In skills', '6', '100%'],
    ['React', 'In skills', '5', '84%'],
    ['GraphQL', 'In experience', '3', '52%'],
    ['Observability', 'Gap', '2', '35%'],
  ] as const;

  return (
    <>
      <PreviewAppBar active="analytics" />
      <div className="landing-window__body landing-analytics-demo">
        <div className="landing-analytics-demo__heading">
          <strong>Analytics</strong>
          <span>What your saved postings ask for and what your profile evidences.</span>
        </div>
        <div className="landing-analytics-demo__controls">
          <div>
            <span>Saved in the last</span>
            <div>
              <b>7 days</b>
              <b>14 days</b>
              <b className="is-active">30 days</b>
              <b>60 days</b>
            </div>
          </div>
          <div>
            <span>Stage</span>
            <div>
              <b className="is-active">All</b>
              <b>Applied</b>
              <b>Screen</b>
              <b>Onsite</b>
              <b>Offer</b>
            </div>
          </div>
          <span className="landing-analytics-demo__toggle">Gaps only</span>
        </div>
        <div className="landing-analytics-demo__summary">
          <span>
            <b>8</b> postings
          </span>
          <span>
            <b>21</b> distinct keywords
          </span>
          <span>
            <b>4</b> not evidenced
          </span>
          <span>
            <b>60%</b> response rate
          </span>
        </div>
        <div className="landing-analytics-demo__grid">
          <div className="landing-analytics-demo__panel">
            <div className="landing-analytics-demo__panel-head">
              <strong>Keywords</strong>
              <span>Min. appearances 2</span>
            </div>
            <p className="landing-analytics-demo__category">Languages & frameworks</p>
            {keywords.map(([term, verdict, count, width]) => (
              <div className="landing-analytics-demo__row" key={term}>
                <i style={{ width }} />
                <span>{term}</span>
                <em className={verdict === 'Gap' ? 'is-gap' : ''}>{verdict}</em>
                <b>{count}</b>
              </div>
            ))}
          </div>
          <div className="landing-analytics-demo__panel">
            <div className="landing-analytics-demo__panel-head">
              <strong>Requirements</strong>
              <span>8 postings</span>
            </div>
            <div className="landing-analytics-demo__evidence">
              <span>
                <b>14</b> evidenced
              </span>
              <span>
                <b>3</b> skill only
              </span>
              <span>
                <b>2</b> unconfirmed
              </span>
              <span>
                <b>2</b> no evidence
              </span>
            </div>
            <p className="landing-analytics-demo__requirement">
              5+ years building production React applications
            </p>
            <p className="landing-analytics-demo__requirement">
              Experience with design systems at scale
            </p>
            <p className="landing-analytics-demo__requirement">Strong written communication</p>
          </div>
        </div>
      </div>
    </>
  );
}

/** Public product page. It intentionally owns no dashboard client and starts no authenticated IO. */
export function LandingPage() {
  const { theme, toggleTheme } = useThemePreference();
  const [previewSlide, setPreviewSlide] = useState<PreviewSlide>('Applications');

  function movePreview(direction: -1 | 1) {
    setPreviewSlide((current) => {
      const index = PREVIEW_SLIDES.indexOf(current);
      return PREVIEW_SLIDES[(index + direction + PREVIEW_SLIDES.length) % PREVIEW_SLIDES.length];
    });
  }

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'djobi — Tailored applications, tracked in one place';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="landing">
      <a className="landing-skip" href="#landing-main">
        Skip to content
      </a>

      <header className="landing-header">
        <div className="landing-shell landing-header__inner">
          <a className="landing-brand" href="/" aria-label="djobi home">
            <img src={logoUrl} alt="" width={30} height={30} />
            <span>djobi</span>
          </a>

          <nav className="landing-nav" aria-label="Landing page">
            <a href="#product">Product</a>
            <a href="#workflow">How it works</a>
            <a href="#principles">Why djobi</a>
            <a href="#faq">FAQ</a>
          </nav>

          <div className="landing-header__actions">
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <a className="landing-button landing-button--small" href={DASHBOARD_PATH}>
              Sign in
            </a>
          </div>
        </div>
      </header>

      <main id="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-shell landing-hero__grid">
            <div className="landing-hero__copy">
              <p className="landing-eyebrow">
                <span /> Chrome extension and tracking dashboard
              </p>
              <h1 id="landing-title">
                Every application tailored. <span>Every outcome tracked.</span>
              </h1>
              <p className="landing-hero__lede">
                The Chrome extension tailors your resume, drafts the freeform answers, and fills the
                form. Save it to the dashboard and you keep a record of what happened next.
              </p>
              <div className="landing-hero__actions">
                <a className="landing-button landing-button--primary" href={DASHBOARD_PATH}>
                  Open dashboard
                  <ArrowIcon />
                </a>
                <a className="landing-button" href="#workflow">
                  See how it works
                </a>
              </div>
              <p className="landing-hero__note">
                <CheckIcon /> You review the final application. djobi never submits it for you.
              </p>
            </div>

            <section
              className="landing-product-shot"
              aria-label="djobi dashboard preview"
              aria-roledescription="carousel"
            >
              <div className="landing-product-shot__glow" />
              <div
                className="landing-window"
                role="group"
                aria-roledescription="slide"
                aria-label={`${PREVIEW_SLIDES.indexOf(previewSlide) + 1} of ${PREVIEW_SLIDES.length}: ${previewSlide}`}
                aria-describedby="landing-preview-description"
                aria-live="polite"
              >
                {previewSlide === 'Applications' ? (
                  <ApplicationsPreview />
                ) : previewSlide === 'Application detail' ? (
                  <ApplicationDetailPreview />
                ) : (
                  <AnalyticsPreview />
                )}
              </div>
              <div
                className="landing-preview-switcher"
                role="group"
                aria-label="Dashboard preview controls"
              >
                <button
                  type="button"
                  className="landing-preview-arrow"
                  aria-label="Previous dashboard preview"
                  onClick={() => movePreview(-1)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m12.5 5-5 5 5 5" />
                  </svg>
                </button>
                <div className="landing-preview-dots" role="group" aria-label="Choose preview">
                  {PREVIEW_SLIDES.map((slide) => (
                    <button
                      key={slide}
                      type="button"
                      className={`landing-preview-dot ${previewSlide === slide ? 'is-active' : ''}`}
                      aria-label={`Show ${slide.toLowerCase()} preview`}
                      aria-pressed={previewSlide === slide}
                      onClick={() => setPreviewSlide(slide)}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="landing-preview-arrow"
                  aria-label="Next dashboard preview"
                  onClick={() => movePreview(1)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m7.5 5 5 5-5 5" />
                  </svg>
                </button>
              </div>
              <p className="landing-preview-description" id="landing-preview-description">
                {PREVIEW_DESCRIPTIONS[previewSlide]}
              </p>
            </section>
          </div>

          <div className="landing-shell landing-ats">
            <p>Works where you already apply</p>
            <ul aria-label="Supported application systems">
              <li>Greenhouse</li>
              <li>Ashby</li>
              <li>Lever</li>
              <li>More coming</li>
            </ul>
          </div>
        </section>

        <section
          className="landing-section landing-product"
          id="product"
          aria-labelledby="product-title"
        >
          <div className="landing-shell">
            <div className="landing-section__intro">
              <p className="landing-kicker">One place for the whole search</p>
              <h2 id="product-title">Applying is the easy part. Keeping track isn't.</h2>
              <p>
                Your profile, the posting, the materials you sent, and everything that happened
                after all live in one place. No more piecing the story back together from tabs and
                spreadsheets.
              </p>
            </div>

            <div className="landing-feature-grid">
              <article className="landing-feature landing-feature--wide">
                <div className="landing-feature__copy">
                  <span className="landing-feature__number">01</span>
                  <h3>Tailored from what you've actually done</h3>
                  <p>
                    Upload a PDF or fill in your profile by hand. djobi picks out what the posting
                    is really asking for, sharpens the experience that matches, and drafts answers
                    from evidence you already gave it.
                  </p>
                </div>
                <div className="landing-resume-demo" aria-hidden="true">
                  <div className="landing-resume-demo__top">
                    <span>Resume match</span>
                    <strong>Role context</strong>
                  </div>
                  <div className="landing-resume-demo__line is-long" />
                  <div className="landing-resume-demo__line" />
                  <div className="landing-resume-demo__match">
                    <CheckIcon /> Evidence from your profile
                  </div>
                </div>
              </article>

              <article className="landing-feature">
                <span className="landing-feature__number">02</span>
                <div
                  className="landing-feature__icon landing-feature__icon--review"
                  aria-hidden="true"
                >
                  <CheckIcon />
                </div>
                <h3>Review before fill</h3>
                <p>
                  Edit any drafted answer, rework it in Ask, and see which required questions still
                  need you before or after the fill. Nothing goes in without your say-so.
                </p>
              </article>

              <article className="landing-feature landing-feature--violet">
                <span className="landing-feature__number">03</span>
                <div className="landing-feature__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M4 18V9M10 18V5M16 18v-7M22 18V3" />
                  </svg>
                </div>
                <h3>See the pattern</h3>
                <p>
                  Track everything you applied to, whether djobi filled it or you did. See which
                  keywords keep coming up, where your profile falls short, and how often you hear
                  back.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section
          className="landing-section landing-workflow"
          id="workflow"
          aria-labelledby="workflow-title"
        >
          <div className="landing-shell landing-workflow__grid">
            <div className="landing-workflow__intro">
              <p className="landing-kicker">From profile to filled form</p>
              <h2 id="workflow-title">Set it up once, then apply.</h2>
              <p>The repetitive parts get faster. The decisions that should be yours stay yours.</p>
              <a href={DASHBOARD_PATH} className="landing-text-link">
                Go to your dashboard <ArrowIcon />
              </a>
            </div>

            <ol className="landing-steps">
              <li>
                <span>1</span>
                <div>
                  <p>Start here</p>
                  <h3>Build your profile</h3>
                  <p>
                    Start from a PDF or fill it in by hand, then add your screening details, the
                    answers you reuse, and the stories you tell.
                  </p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <p>Grab the posting</p>
                  <h3>Capture the role</h3>
                  <p>
                    Open the Chrome side panel, pull in or paste the job description, and check the
                    exact text djobi will work from. If you have applied here before, it says so
                    first.
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <p>Make it fit the role</p>
                  <h3>Analyze, tailor, review</h3>
                  <p>
                    Generate a focused resume and drafts for the required questions, edit or rework
                    them in Ask, then fill the form when you're ready.
                  </p>
                </div>
              </li>
              <li>
                <span>4</span>
                <div>
                  <p>Don't lose the thread</p>
                  <h3>Save, track, learn</h3>
                  <p>
                    Save what the extension filled, or log an application you sent yourself. Move it
                    through the stages, keep notes as you go, and let the analytics show you what to
                    fix.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section
          className="landing-section landing-principles"
          id="principles"
          aria-labelledby="principles-title"
        >
          <div className="landing-shell landing-principles__card">
            <div className="landing-principles__copy">
              <p className="landing-kicker">Where the automation stops</p>
              <h2 id="principles-title">Fast, without being careless.</h2>
              <p>
                djobi is built around checkpoints you control. It prepares and fills the
                application. It doesn't stand in for your judgment, and it never clicks Submit on
                your behalf.
              </p>
            </div>
            <ul>
              <li>
                <CheckIcon />
                <span>
                  <strong>Reviewable by default</strong>
                  Every answer stays editable before the fill.
                </span>
              </li>
              <li>
                <CheckIcon />
                <span>
                  <strong>Your experience is the source</strong>
                  Tailoring starts from the profile you control.
                </span>
              </li>
              <li>
                <CheckIcon />
                <span>
                  <strong>No automatic submission</strong>
                  The employer sees the form only when you send it.
                </span>
              </li>
            </ul>
          </div>
        </section>

        <section className="landing-section landing-faq" id="faq" aria-labelledby="faq-title">
          <div className="landing-shell landing-faq__grid">
            <div>
              <p className="landing-kicker">Good to know</p>
              <h2 id="faq-title">Questions you probably have.</h2>
            </div>
            <div className="landing-faq__list">
              <details>
                <summary>Does djobi submit applications for me?</summary>
                <p>
                  No. djobi prepares your materials and fills the fields it finds, but you review
                  the page and submit the employer's form yourself.
                </p>
              </details>
              <details>
                <summary>Can I edit the generated answers?</summary>
                <p>
                  Yes. Every drafted answer is yours to review and edit before the fill. You can
                  also use Ask to rework a draft, or to answer a question the extension didn't pick
                  up.
                </p>
              </details>
              <details>
                <summary>How do the extension and dashboard work together?</summary>
                <p>
                  Autofill runs in the extension's side panel. The dashboard works from the same
                  profile and the same saved applications, including the ones you logged yourself,
                  plus stages, materials, notes, and analytics.
                </p>
              </details>
              <details>
                <summary>What can I track in the dashboard?</summary>
                <p>
                  Search by company or role, move applications through your stages, keep notes by
                  category, and reread any saved posting or resume. Analytics covers recurring
                  keywords, gaps in your profile, and how often you hear back.
                </p>
              </details>
              <details>
                <summary>Which application systems does it support?</summary>
                <p>
                  djobi is built for Greenhouse, Ashby, and Lever. When it can't fill a field
                  confidently, it says so instead of guessing. More platforms are on the way.
                </p>
              </details>
            </div>
          </div>
        </section>

        <section className="landing-final" aria-labelledby="landing-final-title">
          <div className="landing-shell landing-final__inner">
            <img src={logoUrl} alt="" width={48} height={48} />
            <p className="landing-kicker">Start with your experience</p>
            <h2 id="landing-final-title">Build your profile, then take it to every application.</h2>
            <p>
              Upload a resume or fill in your profile, and every application after it starts from
              there.
            </p>
            <a className="landing-button landing-button--primary" href={DASHBOARD_PATH}>
              Open dashboard
              <ArrowIcon />
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-shell">
          <a className="landing-brand" href="/" aria-label="djobi home">
            <img src={logoUrl} alt="" width={26} height={26} />
            <span>djobi</span>
          </a>
          <p>Tailored applications, tracked in one place.</p>
          <a href={DASHBOARD_PATH}>Dashboard</a>
        </div>
      </footer>
    </div>
  );
}
