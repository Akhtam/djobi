/**
 * Analytics: keyword frequency and its coverage badges, the requirements panel, and the range/stage
 * filters they share with the applications list.
 */
import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { HttpError } from '@djobi/http-client';
import type { Application } from '@djobi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureDashboardClient } from '../lib/dashboardClient';
import { fixtureApplications, fixtureProfile } from '../lib/fixtures';
import { renderDashboard } from './test-utils';

async function lowerAnalyticsMinimumToOne(user: ReturnType<typeof userEvent.setup>) {
  const decrease = await screen.findByRole('button', { name: 'Decrease minimum appearances' });
  for (let value = 5; value > 1; value--) await user.click(decrease);
}

describe('analytics', () => {
  // `fixtures.ts` is left alone (its `createdAt` values are absolute and already months stale), so
  // this is the one test file that fakes the clock — `rangeStart` taking `today` as a parameter is
  // what keeps everything else clock-free. Noon UTC keeps the local calendar date the same day
  // across the timezones this suite is likely to run under.
  beforeEach(() => {
    window.location.hash = '#/analytics';
    vi.setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is reachable from the nav and marks itself current', async () => {
    const { user } = renderDashboard({ hash: '#/' });

    await user.click(await screen.findByRole('link', { name: 'Analytics' }));

    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Applications' })).not.toHaveAttribute('aria-current');
  });

  it('shows a keyword frequency table over the default 7-day range', async () => {
    const { user } = renderDashboard();
    await lowerAnalyticsMinimumToOne(user);

    // React is asked for by Anthropic, Brex and Linear within seven days of the fixed clock.
    const reactRow = await screen.findByRole('button', { name: /React/ });
    expect(within(reactRow).getByText('3')).toBeInTheDocument();
  });

  it('groups the keyword table into category sections', async () => {
    const { user } = renderDashboard();
    await lowerAnalyticsMinimumToOne(user);

    await screen.findByRole('button', { name: /React/ });
    expect(screen.getByText('Frameworks')).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
  });

  it('narrows the keyword table to terms that appeared at least N times', async () => {
    const { user } = renderDashboard();
    await lowerAnalyticsMinimumToOne(user);
    await screen.findByRole('button', { name: /GraphQL/ });

    const increase = screen.getByRole('button', { name: 'Increase minimum appearances' });
    await user.click(increase);

    // React (3) and TypeScript (2) cleared the bar; GraphQL and Next.js (1 each) did not.
    expect(screen.getByRole('button', { name: /React/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /TypeScript/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /GraphQL/ })).not.toBeInTheDocument();
  });

  it('cannot decrease the minimum below 1, and shows the current value', async () => {
    const { user } = renderDashboard();

    const stepper = await screen.findByRole('group', { name: 'Min. appearances' });
    const decrease = within(stepper).getByRole('button', { name: 'Decrease minimum appearances' });
    expect(within(stepper).getByText('5')).toBeInTheDocument();
    expect(decrease).not.toBeDisabled();

    for (let value = 5; value > 1; value--) await user.click(decrease);
    expect(decrease).toBeDisabled();

    const increase = within(stepper).getByRole('button', { name: 'Increase minimum appearances' });
    await user.click(increase);
    await user.click(increase);
    expect(within(stepper).getByText('3')).toBeInTheDocument();

    await user.click(decrease);
    expect(within(stepper).getByText('2')).toBeInTheDocument();
  });

  it('explains an empty keyword table caused by the appearance filter', async () => {
    renderDashboard();

    expect(await screen.findByText('No keywords match these filters')).toBeInTheDocument();
    // The range/stage controls stay usable — the same rule every other empty state here follows.
    expect(
      screen.getByRole('button', { name: 'Increase minimum appearances' }),
    ).toBeInTheDocument();
  });

  it('shows a summary strip over the filtered range', async () => {
    const { container } = renderDashboard();

    await screen.findByRole('group', { name: 'Min. appearances' });
    // Anthropic, Linear and Brex fall within the default seven-day range.
    const summary = container.querySelector('.analytics-summary');
    expect(summary).toHaveTextContent('3 postings');
  });

  it('highlights the selected keyword inside each requirement’s text', async () => {
    const { user } = renderDashboard();
    await lowerAnalyticsMinimumToOne(user);
    const reactRow = await screen.findByRole('button', { name: /^React/ });

    await user.click(reactRow);

    // Both Anthropic's and Brex's first requirement mention "React" in the sentence itself.
    const marks = await screen.findAllByText('React', { selector: 'mark' });
    expect(marks.length).toBeGreaterThan(0);
  });

  it('groups each posting under one Required and one Preferred heading', async () => {
    renderDashboard();

    const link = await screen.findByRole('link', {
      name: /Brex — Senior Frontend Engineer/,
    });
    const posting = link.closest('article') as HTMLElement;
    const required = within(posting).getByRole('heading', { name: 'required', level: 3 });
    const preferred = within(posting).getByRole('heading', { name: 'preferred', level: 3 });

    expect(within(posting).getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(
      within(required.closest('section')!).getByText(/5\+ years building production React/),
    ).toBeInTheDocument();
    // Unclassified requirements stay visible under Required instead of creating a third heading.
    expect(
      within(required.closest('section')!).getByText(/Comfort owning a service end to end/),
    ).toBeInTheDocument();
    expect(
      within(preferred.closest('section')!).getByText(/Experience with design systems at scale/),
    ).toBeInTheDocument();
  });

  it('narrows the range and drops postings outside it', async () => {
    const { user } = renderDashboard({ hash: '#/analytics?range=30d' });
    await lowerAnalyticsMinimumToOne(user);
    await screen.findByRole('button', { name: /React/ });

    await user.click(screen.getByRole('button', { name: '7 days' }));

    // Only Anthropic (3/19), Linear (3/16) and Brex (3/14) fall within 7 days of 3/20.
    const reactRow = await screen.findByRole('button', { name: /React/ });
    expect(within(reactRow).getByText('3')).toBeInTheDocument();
  });

  it('filters by stage using the same pills the applications list uses', async () => {
    const { user } = renderDashboard();
    await lowerAnalyticsMinimumToOne(user);
    await screen.findByRole('button', { name: /React/ });

    await user.click(screen.getByRole('button', { name: /^Onsite/ }));

    // Brex is the only onsite-stage posting inside the default 7-day range — Stripe is also
    // onsite but its createdAt falls outside it.
    expect(screen.getByRole('button', { name: /GraphQL/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next\.js/ })).not.toBeInTheDocument();
  });

  it('counts a stage pill against the selected range, not against every application ever saved', async () => {
    renderDashboard();
    await screen.findByRole('group', { name: 'Min. appearances' });

    // Two applications are onsite-stage (Brex and the legacy Stripe row), but Stripe's
    // createdAt falls outside the default 7-day range — the pill must count only Brex.
    expect(screen.getByRole('button', { name: /^Onsite/ })).toHaveAccessibleName('Onsite1');
  });

  it('shows a notice instead of coverage badges when no Profile is saved', async () => {
    renderDashboard({ client: createFixtureDashboardClient(fixtureApplications) });

    expect(await screen.findByText(/No profile saved yet/)).toBeInTheDocument();
  });

  it('shows a failure notice when the Profile cannot be reached', async () => {
    renderDashboard({
      client: {
        ...createFixtureDashboardClient(fixtureApplications),
        getProfile: () => Promise.reject(new Error('backend is not running')),
      },
    });

    expect(await screen.findByText(/Couldn.t load your profile/)).toBeInTheDocument();
    expect(screen.getByText(/backend is not running/)).toBeInTheDocument();
  });

  it('clears cached applications and redirects to sign-in when loading the Profile returns 401', async () => {
    renderDashboard({
      client: {
        ...createFixtureDashboardClient(fixtureApplications),
        getProfile: () =>
          Promise.reject(new HttpError('http', '/profile', 'Authentication required', 401)),
      },
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/login?from=%23%2Fanalytics');
    expect(screen.queryByText(/Couldn.t load your profile/)).not.toBeInTheDocument();
    expect(screen.queryByText('Brex')).not.toBeInTheDocument();
  });

  it('shows coverage badges and narrows Gaps only to what the Profile does not evidence', async () => {
    const { user } = renderDashboard({
      client: createFixtureDashboardClient(fixtureApplications, fixtureProfile),
    });
    await lowerAnalyticsMinimumToOne(user);

    // React is in fixtureProfile's skills — covered. Next.js is not, and evidences nowhere else.
    const reactRow = await screen.findByRole('button', { name: /React/ });
    expect(within(reactRow).getByText('In skills')).toBeInTheDocument();
    const nextJsRow = screen.getByRole('button', { name: /Next\.js/ });
    expect(within(nextJsRow).getByText('Gap')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Gaps only' }));

    expect(screen.queryByRole('button', { name: /^React / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next\.js/ })).toBeInTheDocument();
  });

  it('narrows the requirements panel to postings that asked for a selected keyword', async () => {
    const { user } = renderDashboard({ hash: '#/analytics?range=30d' });
    await lowerAnalyticsMinimumToOne(user);
    const nextJsRow = await screen.findByRole('button', { name: /Next\.js/ });

    await user.click(nextJsRow);

    // Next.js is asked for by Anthropic and Vercel; Brex is not.
    expect(
      await screen.findByRole('link', { name: /Anthropic — Member of Technical Staff, Product/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Vercel — Software Engineer, Developer Experience/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Brex — Senior Frontend Engineer/ }),
    ).not.toBeInTheDocument();
  });

  it('presents requested experience as readable thresholds', async () => {
    const applications = structuredClone(fixtureApplications.slice(0, 2));
    applications[0].jobInfo.requirements[0].yearsOfExperience = 1;
    applications[1].jobInfo.requirements[1].yearsOfExperience = 5;
    const { user, container } = renderDashboard({
      client: createFixtureDashboardClient(applications),
    });

    await screen.findByRole('group', { name: 'Min. appearances' });
    const summary = container.querySelector('.analytics-summary-strip') as HTMLElement;
    const toggle = within(summary).getByRole('button', { name: /^Experience requested/ });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(summary).toHaveTextContent('2 thresholds');
    expect(summary.querySelectorAll('.analytics-summary-strip__year')).toHaveLength(0);

    await user.click(toggle);

    const thresholds = summary.querySelectorAll('.analytics-summary-strip__year');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(thresholds[0]).toHaveTextContent('1+ year · 1 request');
    expect(thresholds[1]).toHaveTextContent('5+ years · 2 requests');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(summary.querySelectorAll('.analytics-summary-strip__year')).toHaveLength(0);
  });

  it('scopes the requirements summary to postings matching the selected keyword', async () => {
    const { user, container } = renderDashboard({ hash: '#/analytics?range=30d' });
    await lowerAnalyticsMinimumToOne(user);

    await user.click(await screen.findByRole('button', { name: /Next\.js/ }));

    const summary = container.querySelector('.analytics-summary-strip');
    expect(summary).not.toHaveTextContent('Experience requested');
    expect(summary).not.toHaveTextContent('5+ years');
  });

  it('returns to Analytics with its filters intact from a posting opened in the requirements panel', async () => {
    const { user } = renderDashboard();
    await user.click(await screen.findByRole('button', { name: '30 days' }));
    const link = await screen.findByRole('link', {
      name: /Anthropic — Member of Technical Staff, Product/,
    });

    await user.click(link);

    const back = await screen.findByRole('link', { name: '← Analytics' });
    expect(back).toHaveAttribute('href', '#/analytics?range=30d');
  });

  it('keeps the range and stage controls visible when nothing is in range', async () => {
    const { user } = renderDashboard();
    await screen.findByRole('group', { name: 'Min. appearances' });
    // Ramp (3/8) is the only phone_screen-stage posting, and it falls outside 7 days of 3/20.
    await user.click(screen.getByRole('button', { name: /^Phone screen/ }));

    expect(
      await screen.findByText(/Widen the range or change the stage filter/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Phone screen/ })).toBeInTheDocument();
  });

  it('shows the empty state with no applications at all', async () => {
    renderDashboard({ client: createFixtureDashboardClient([]) });

    expect(
      await screen.findByText(/No applications yet\. Fill one in with the extension/),
    ).toBeInTheDocument();
  });

  describe('response rates', () => {
    /*
     * The fixture rows deliberately never reach `MIN_DECIDED_FOR_RATE` in any range — five resolved
     * postings is more than eight rows spread over three months can supply once the two pending
     * ones are excluded — so the test that needs a *rendered* percentage builds its own set. The
     * fixtures still cover the case that matters most: a rate withheld for want of data.
     */
    function staged(stages: readonly Application['stage'][]): Application[] {
      const [template] = fixtureApplications;
      return stages.map((stage, index) => ({
        ...structuredClone(template),
        id: `app-staged-${index}`,
        stage,
        createdAt: new Date(Date.UTC(2026, 2, 18)).toISOString(),
      }));
    }

    it('reports a response rate over the postings that resolved, not the ones still waiting', async () => {
      // Three of ten resolved postings responded; the eleventh is still out.
      const applications = staged([
        'offer',
        'phone_screen',
        'onsite',
        'rejected_ats',
        'rejected_ats',
        'rejected_ats',
        'rejected_ats',
        'rejected_ats',
        'rejected_ats',
        'rejected_ats',
        'applied',
      ]);
      renderDashboard({ client: createFixtureDashboardClient(applications) });

      const summary = await screen.findByText(/response rate/);
      expect(summary).toHaveTextContent('30% response rate');
      expect(summary).toHaveTextContent('1 pending');
    });

    it('withholds the rate rather than printing a percentage over too few resolved postings', async () => {
      renderDashboard();

      // The default 7-day range holds three fixture postings, only two of them resolved.
      const summary = await screen.findByText(/response rate/);
      expect(summary).toHaveTextContent('— response rate');
      expect(summary).not.toHaveTextContent('%');
    });

    it('hides the rate entirely while a stage filter selects on the outcome being measured', async () => {
      const { user } = renderDashboard();
      await user.click(await screen.findByRole('button', { name: '60 days' }));
      await screen.findByText(/response rate/);

      await user.click(screen.getByRole('button', { name: /^Onsite/ }));

      expect(screen.queryByText(/response rate/)).not.toBeInTheDocument();
    });
  });

  describe('requirement evidence', () => {
    it('rolls up the stored verdicts and states how many postings carry none', async () => {
      renderDashboard();

      // Brex is the one scored fixture row; the other two in the default range predate the field.
      expect(await screen.findByText('1 dropped from resume')).toBeInTheDocument();
      expect(screen.getByText('2 evidenced')).toBeInTheDocument();
      expect(screen.getByText(/over 1 of 3 postings/)).toBeInTheDocument();

      // Every verdict is accounted for, so the strip sums to Brex's four requirements rather than
      // leaving one of them uncounted.
      expect(screen.getByText('1 unconfirmed')).toBeInTheDocument();
      expect(screen.getByText('0 skill only')).toBeInTheDocument();
      expect(screen.getByText('0 unevidenced')).toBeInTheDocument();
    });

    it('badges a requirement whose evidence the tailored resume dropped, and quotes the bullet', async () => {
      renderDashboard();

      expect(await screen.findByText('Dropped from resume')).toBeInTheDocument();
      expect(screen.getByText(/Reduced p99 checkout latency/)).toBeInTheDocument();
    });

    it('leaves an evidenced requirement unbadged, so only the ones worth acting on carry one', async () => {
      renderDashboard();

      await screen.findByText('Dropped from resume');
      expect(screen.queryByText('Evidenced')).not.toBeInTheDocument();
    });
  });
});
