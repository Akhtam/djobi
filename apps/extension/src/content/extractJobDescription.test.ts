import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractJobDescription, extractJobDescriptionWhenReady } from './extractJobDescription';

/** Resolved against this file, not the working directory — see the note in `greenhouseForm.test.ts`. */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8');
}

const LONG_ABOUT =
  'Acme builds reliable infrastructure for teams around the world. Our engineers work closely with customers and product partners to solve meaningful operational problems.';

describe('extractJobDescription', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.title = '';
    history.replaceState({}, '', '/');
    vi.useRealTimers();
  });

  it('prefers nested JobPosting JSON-LD and includes separate qualification fields', () => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', name: 'Acme' },
        {
          '@type': ['Thing', 'https://schema.org/JobPosting'],
          title: 'Senior Platform Engineer',
          hiringOrganization: { name: 'Acme' },
          description: `<h2>About Acme</h2><p>${LONG_ABOUT}</p><h2>What you'll do</h2><ul><li>Build distributed systems.</li><li>Partner with product teams.</li></ul>`,
          qualifications:
            'You have production TypeScript experience and a record of operating distributed systems.',
        },
      ],
    });
    document.head.append(script);

    const result = extractJobDescription(document);

    expect(result?.source).toBe('structured-data');
    expect(result?.text).toContain('Senior Platform Engineer');
    expect(result?.text).toContain("What you'll do");
    expect(result?.text).toContain('Qualifications');
    expect(result?.text).toContain('production TypeScript experience');
  });

  it('decodes mixed and nested HTML entities in structured descriptions such as Brex postings', () => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Software Engineer',
      hiringOrganization: { name: 'Brex' },
      description: `<div><p>${LONG_ABOUT} We give you the support needed to grow your career.&lt;/p&gt;&lt;/div&gt;&lt;p&gt;&lt;strong&gt;Engineering at Brex&lt;/strong&gt;&lt;/p&gt;
        &amp;lt;p&amp;gt;Engineering at Brex is about building systems that scale with speed and intention. Our teams operate with high autonomy and deep collaboration.&amp;lt;/p&amp;gt;
        <p><strong>Requirements</strong></p><ul><li>Experience shipping reliable production systems.</li></ul>`,
    });
    document.head.append(script);

    const result = extractJobDescription(document);

    expect(result?.source).toBe('structured-data');
    expect(result?.text).toContain('Engineering at Brex');
    expect(result?.text).toContain('Requirements');
    expect(result?.text).not.toMatch(/&(?:amp;)?lt;|<\/?(?:p|div|strong)>/i);
  });

  it('categorically prefers the structured posting whose URL matches the current job', () => {
    history.replaceState({}, '', '/jobs/current');
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify([
      {
        '@type': 'JobPosting',
        url: '/jobs/current',
        title: 'Current Role',
        description: `<p>${LONG_ABOUT} ${LONG_ABOUT} This is the CURRENT posting and its required experience.</p>`,
      },
      {
        '@type': 'JobPosting',
        url: '/jobs/related',
        title: 'Related Role',
        description: `<p>${`${LONG_ABOUT} `.repeat(12)} This is the WRONG related posting.</p>`,
      },
    ]);
    document.head.append(script);

    const result = extractJobDescription(document);

    expect(result?.text).toContain('CURRENT posting');
    expect(result?.text).not.toContain('WRONG related posting');
  });

  it('rejects explicitly nonmatching structured data and falls back to the current DOM posting', () => {
    history.replaceState({}, '', '/jobs/current');
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      '@type': 'JobPosting',
      url: '/jobs/stale',
      title: 'Stale Role',
      description: `<p>${LONG_ABOUT} ${LONG_ABOUT} This stale structured posting belongs to another job.</p>`,
    });
    document.head.append(script);
    document.body.innerHTML = `
      <main class="job-description">
        <h1>Current Role</h1>
        <h2>About the role</h2>
        <p>${LONG_ABOUT} ${LONG_ABOUT}</p>
        <h2>Qualifications</h2>
        <p>This CURRENT DOM posting requires production engineering experience.</p>
      </main>
    `;

    const result = extractJobDescription(document);

    expect(result?.source).toBe('dom');
    expect(result?.text).toContain('CURRENT DOM posting');
    expect(result?.text).not.toContain('stale structured posting');
  });

  it('falls back from malformed JSON-LD to a focused DOM description', () => {
    document.head.innerHTML = `<script type="application/ld+json">{"broken":</script>`;
    document.body.innerHTML = `
      <header>Careers Navigation</header>
      <main>
        <div class="job-description">
          <h1>Staff Engineer</h1>
          <h2>About the company</h2>
          <p>${LONG_ABOUT}</p>
          <h2>What you'll bring</h2>
          <ul><li>Experience designing APIs used by other engineering teams.</li></ul>
        </div>
      </main>
    `;

    const result = extractJobDescription(document);

    expect(result?.source).toBe('dom');
    expect(result?.text).toContain('About the company');
    expect(result?.text).toContain("What you'll bring");
    expect(result?.text).not.toContain('Careers Navigation');
  });

  it('removes application controls and stops before application boilerplate', () => {
    document.body.innerHTML = `
      <main data-testid="job-description">
        <h1>Product Engineer</h1>
        <h2>The opportunity</h2>
        <p>${LONG_ABOUT}</p>
        <h2>Who you are</h2>
        <p>You communicate clearly and have several years of product engineering experience.</p>
        <h2>Apply for this job</h2>
        <form><label>Email <input name="email" /></label><button>Submit application</button></form>
        <p>Application privacy notice and recruiting consent text.</p>
      </main>
    `;

    const result = extractJobDescription(document);

    expect(result?.text).toContain('Who you are');
    expect(result?.text).not.toContain('Apply for this job');
    expect(result?.text).not.toContain('Application privacy notice');
    expect(result?.text).not.toContain('Submit application');
  });

  it('reads a description rendered inside an open shadow root', () => {
    const host = document.createElement('job-posting');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <article class="job-description">
        <h1>Infrastructure Engineer</h1>
        <h2>About the role</h2>
        <p>${LONG_ABOUT}</p>
        <h2>Qualifications</h2>
        <p>You have deep Linux and networking experience in production environments.</p>
      </article>
    `;

    expect(extractJobDescription(document)?.text).toContain('deep Linux and networking experience');
  });

  it('reads a Rippling posting: no JSON-LD, no landmark element, conversational headings', () => {
    // Every ingredient the scorer used to rely on is missing here, which is why this page returned
    // nothing: Rippling ships no JobPosting JSON-LD, wraps the posting in a plain `div` rather than
    // `main`/`article`, and titles its sections the way a person would speak instead of
    // "Responsibilities"/"Qualifications". `.ATS_htmlPreview` is the one durable handle on the page
    // — the rest of its classes are Emotion hashes.
    document.body.innerHTML = `
      <div class="css-1nb1zny">
        <h2>Full Stack Product Engineer</h2>
        <div class="ATS_htmlPreview">
          <p>${LONG_ABOUT}</p>
          <h2>You can expect to:</h2>
          <ul><li>Ship product surfaces used by clinics every day.</li></ul>
          <h2>You&rsquo;d be great for this role if you:</h2>
          <ul><li>Have shipped and owned production web applications.</li></ul>
          <h2>Nice to have:</h2>
          <ul><li>Exposure to healthcare or regulated data.</li></ul>
        </div>
      </div>
    `;

    const result = extractJobDescription(document);

    expect(result?.source).toBe('dom');
    expect(result?.text).toContain('You can expect to:');
    expect(result?.text).toContain('Nice to have:');
  });

  it('reads a real Greenhouse job-boards posting rather than the page it is embedded in', () => {
    // Captured live from `job-boards.greenhouse.io/otter/jobs/7820368002`, and it defeated every
    // path at once: no JSON-LD, a BEM container (`job__description`) that the separator-literal
    // strong selectors missed, and sections marked with `<p><strong>` instead of `h2`. What was
    // left was `<main>` — the posting plus the whole application form, 37 controls' worth of
    // penalty — scoring 32 against a threshold of 35, so the page returned nothing at all.
    document.body.innerHTML = fixture('otter-greenhouse.html');

    const result = extractJobDescription(document);

    expect(result?.source).toBe('dom');
    expect(result?.text).toContain('Core Responsibilities');
    expect(result?.text).toContain('Proficiency in backend programming languages');
    // The description container won, not `<main>`: the form and its boilerplate are absent.
    expect(result?.text).not.toContain('Voluntary Self-Identification');
    expect(result?.text).not.toContain('Accepted file types');
  });

  it('nominates a posting whose only section headings are bold lines', () => {
    // No landmark element and no container name to match — the bold lines are the sole evidence
    // that this is a sectioned posting, so they have to seed the candidate as a heading would.
    document.body.innerHTML = `
      <div class="css-8fj20a">
        <div class="posting-body">
          <p><strong>Who We Are</strong></p>
          <p>${LONG_ABOUT}</p>
          <p><strong>What You&rsquo;ll Do</strong></p>
          <ul><li>Design and operate backend services.</li></ul>
          <p><strong>Basic Qualifications</strong></p>
          <ul><li>Five years of relevant software engineering experience.</li></ul>
        </div>
      </div>
    `;

    const result = extractJobDescription(document);

    expect(result?.source).toBe('dom');
    expect(result?.text).toContain('Who We Are');
    expect(result?.text).toContain('Basic Qualifications');
  });

  it('matches a description container written in either underscore convention', () => {
    document.body.innerHTML = `
      <div class="job_description">
        <p>${LONG_ABOUT} ${LONG_ABOUT}</p>
        <p>Five years of relevant software engineering experience.</p>
      </div>
    `;

    expect(extractJobDescription(document)?.source).toBe('dom');
  });

  it('does not read inline emphasis as a section heading', () => {
    // The guardrail on the bold-heading rule: bolding a recognized word mid-sentence is not a
    // section, and an article that leans on it must not inherit a posting's structure credit.
    document.body.innerHTML = `
      <main>
        <h1>Software engineering</h1>
        <p>${LONG_ABOUT} Practitioners disagree about how much <b>experience</b> is required.</p>
        <p>${LONG_ABOUT} Definitions of <strong>qualifications</strong> vary by institution.</p>
        <ul><li>Definitions vary between practitioners and institutions.</li></ul>
      </main>
    `;

    expect(extractJobDescription(document)).toBeNull();
  });

  it('still says no to an article that is merely prose in sections', () => {
    // The counterweight to the heading vocabulary above: a page can be long, sectioned and
    // list-heavy without being a job posting, and crediting unrecognized headings for their
    // structure alone was enough to let encyclopedia and documentation pages through.
    document.body.innerHTML = `
      <main>
        <h1>Software engineering</h1>
        <h2>History</h2>
        <p>${LONG_ABOUT} ${LONG_ABOUT}</p>
        <h2>Terminology</h2>
        <ul><li>Definitions vary between practitioners and institutions.</li></ul>
        <h2>See also</h2>
      </main>
    `;

    expect(extractJobDescription(document)).toBeNull();
  });

  it('fails closed on a navigation/application shell instead of returning all body text', () => {
    document.body.innerHTML = `
      <nav>Home Careers Teams Sign in</nav>
      <main><h1>Apply</h1><form><input name="name" /><button>Continue</button></form></main>
    `;

    expect(extractJobDescription(document)).toBeNull();
  });

  it('waits briefly for a client-rendered posting and disconnects after finding it', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main id="app"></main>`;

    const pending = extractJobDescriptionWhenReady(document, { timeoutMs: 1000, settleMs: 50 });
    document.querySelector('#app')!.innerHTML = `
      <article class="job-description">
        <h2>About us</h2><p>${LONG_ABOUT} ${LONG_ABOUT}</p>
        <h2>Requirements</h2><p>Five years of relevant software engineering experience.</p>
      </article>
    `;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toMatchObject({ source: 'dom' });
  });
});
