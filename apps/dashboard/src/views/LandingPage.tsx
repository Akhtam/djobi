import { useEffect, type CSSProperties } from 'react';
import logoUrl from '../assets/icons/djobi-icon.svg';
import { ThemeToggle, useThemePreference } from '../lib/theme';

const DASHBOARD_PATH = '/#/';

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

/** Public product page. It intentionally owns no dashboard client and starts no authenticated IO. */
export function LandingPage() {
  const { theme, toggleTheme } = useThemePreference();

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'djobi - Tailored applications, organized';
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
                <span /> Your application workflow, connected
              </p>
              <h1 id="landing-title">
                Apply with context. <span>Follow up with clarity.</span>
              </h1>
              <p className="landing-hero__lede">
                djobi helps you tailor the work, review every answer, fill the form, and keep the
                opportunity moving after you apply.
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

            <div
              className="landing-product-shot"
              role="img"
              aria-label="Example djobi application dashboard"
            >
              <div className="landing-product-shot__glow" />
              <div className="landing-window">
                <div className="landing-window__bar">
                  <div className="landing-window__dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="landing-window__brand">
                    <img src={logoUrl} alt="" width={18} height={18} />
                    <span>djobi</span>
                  </div>
                  <span className="landing-window__label">Example workspace</span>
                </div>

                <div className="landing-window__body">
                  <div className="landing-window__heading">
                    <div>
                      <span className="landing-window__kicker">Your pipeline</span>
                      <strong>Applications</strong>
                    </div>
                    <span className="landing-window__search">Search roles...</span>
                  </div>

                  <div className="landing-stage-row" aria-hidden="true">
                    <span className="is-active">
                      All <b>18</b>
                    </span>
                    <span>
                      Applied <b>8</b>
                    </span>
                    <span>
                      Screen <b>5</b>
                    </span>
                    <span>
                      Onsite <b>3</b>
                    </span>
                  </div>

                  <div className="landing-demo-list">
                    <article>
                      <div>
                        <span className="landing-demo-list__company">Arc Labs</span>
                        <strong>Senior Frontend Engineer</strong>
                      </div>
                      <span className="landing-demo-stage landing-demo-stage--onsite">Onsite</span>
                    </article>
                    <article>
                      <div>
                        <span className="landing-demo-list__company">Northstar</span>
                        <strong>Product Engineer</strong>
                      </div>
                      <span className="landing-demo-stage landing-demo-stage--screen">
                        Phone screen
                      </span>
                    </article>
                    <article>
                      <div>
                        <span className="landing-demo-list__company">Fieldwork</span>
                        <strong>Software Engineer, Platform</strong>
                      </div>
                      <span className="landing-demo-stage landing-demo-stage--applied">
                        Applied
                      </span>
                    </article>
                  </div>

                  <div className="landing-window__insight">
                    <div>
                      <span>Strongest signal</span>
                      <strong>TypeScript</strong>
                    </div>
                    <div className="landing-mini-bars" aria-hidden="true">
                      <i style={{ '--bar-width': '86%' } as CSSProperties} />
                      <i style={{ '--bar-width': '68%' } as CSSProperties} />
                      <i style={{ '--bar-width': '48%' } as CSSProperties} />
                    </div>
                    <span className="landing-window__trend">9 postings</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="landing-shell landing-ats">
            <p>Designed for the places you already apply</p>
            <ul aria-label="Supported application systems">
              <li>Greenhouse</li>
              <li>Ashby</li>
              <li>Lever</li>
              <li>Workday</li>
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
              <p className="landing-kicker">One continuous workspace</p>
              <h2 id="product-title">The application does not end at autofill.</h2>
              <p>
                Keep the job context, your tailored materials, and every next step together instead
                of rebuilding the story across tabs and spreadsheets.
              </p>
            </div>

            <div className="landing-feature-grid">
              <article className="landing-feature landing-feature--wide">
                <div className="landing-feature__copy">
                  <span className="landing-feature__number">01</span>
                  <h3>Tailoring with a memory</h3>
                  <p>
                    Start from your real experience. djobi extracts what matters in the posting and
                    shapes the resume and freeform answers around evidence you already have.
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
                  Edit every drafted answer and resolve required fields before anything reaches the
                  page. You keep the final say.
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
                  Track stages, notes, recurring requirements, and skill gaps across the roles you
                  actually chose to pursue.
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
              <p className="landing-kicker">A calmer way through the form</p>
              <h2 id="workflow-title">From job post to next conversation.</h2>
              <p>
                The repetitive parts move faster. The decisions that should stay yours remain yours.
              </p>
              <a href={DASHBOARD_PATH} className="landing-text-link">
                Go to your dashboard <ArrowIcon />
              </a>
            </div>

            <ol className="landing-steps">
              <li>
                <span>1</span>
                <div>
                  <p>Bring the posting into focus</p>
                  <h3>Capture the role</h3>
                  <p>
                    Scrape or paste the job description, then review the exact context djobi will
                    use.
                  </p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <p>Build from your experience</p>
                  <h3>Analyze, tailor, review</h3>
                  <p>
                    Generate a focused resume and answer drafts, edit them, then fill the form when
                    they are ready.
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <p>Keep the opportunity moving</p>
                  <h3>Save, track, learn</h3>
                  <p>
                    Move the application through your pipeline, add notes, and use analytics to
                    prepare for what comes next.
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
              <p className="landing-kicker">Automation with boundaries</p>
              <h2 id="principles-title">Faster does not have to mean careless.</h2>
              <p>
                djobi is built around deliberate checkpoints. It helps prepare and fill your work;
                it does not impersonate your judgment or click Submit behind your back.
              </p>
            </div>
            <ul>
              <li>
                <CheckIcon />
                <span>
                  <strong>Reviewable by default</strong>
                  Answers stay editable before fill.
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
                  The employer receives the form only when you send it.
                </span>
              </li>
            </ul>
          </div>
        </section>

        <section className="landing-section landing-faq" id="faq" aria-labelledby="faq-title">
          <div className="landing-shell landing-faq__grid">
            <div>
              <p className="landing-kicker">Good to know</p>
              <h2 id="faq-title">Questions before you begin.</h2>
            </div>
            <div className="landing-faq__list">
              <details>
                <summary>Does djobi submit applications for me?</summary>
                <p>
                  No. djobi can prepare materials and fill detected fields, but you review the page
                  and submit the employer's form yourself.
                </p>
              </details>
              <details>
                <summary>Can I edit the generated answers?</summary>
                <p>
                  Yes. Every drafted freeform answer is reviewable and editable before you choose to
                  fill it into the application.
                </p>
              </details>
              <details>
                <summary>What can I track in the dashboard?</summary>
                <p>
                  Search applications by company or role, update pipeline stages, keep notes, review
                  saved materials, and explore recurring requirements in Analytics.
                </p>
              </details>
              <details>
                <summary>Which application systems does it support?</summary>
                <p>
                  djobi is designed for common ATS experiences including Greenhouse, Ashby, Lever,
                  and Workday, with verification when fields cannot be filled confidently.
                </p>
              </details>
            </div>
          </div>
        </section>

        <section className="landing-final" aria-labelledby="landing-final-title">
          <div className="landing-shell landing-final__inner">
            <img src={logoUrl} alt="" width={48} height={48} />
            <p className="landing-kicker">Your search, with a system</p>
            <h2 id="landing-final-title">Put every application in motion.</h2>
            <p>Spend less energy rebuilding context and more on choosing the right next step.</p>
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
          <p>Thoughtful automation for a more focused job search.</p>
          <a href={DASHBOARD_PATH}>Dashboard</a>
        </div>
      </footer>
    </div>
  );
}
