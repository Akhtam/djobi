import type { KeywordCoverage } from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from '../lib/fakeChrome';
import { CoverageReport } from './CoverageReport';

const missing: KeywordCoverage = { keyword: 'Kubernetes', verdict: 'missing', evidence: null };
const inSkills: KeywordCoverage = { keyword: 'Redis', verdict: 'skills', evidence: 'Redis' };
const inExperience: KeywordCoverage = {
  keyword: 'Terraform',
  verdict: 'experience',
  evidence: 'Managed the Terraform modules for three environments',
};
const profileExperience: KeywordCoverage = {
  keyword: 'Kubernetes',
  verdict: 'profile-experience',
  evidence: 'Provisioned Kubernetes clusters with Terraform',
};

describe('CoverageReport', () => {
  beforeEach(() => vi.unstubAllGlobals());

  /** The report's own summary, which carries the gap count alongside its heading. */
  function reportSummary() {
    return screen.getByText(/Keywords from this posting/, { selector: 'summary' });
  }

  function openReport() {
    fireEvent.click(reportSummary());
  }

  function openMissingKeywords() {
    fireEvent.click(screen.getByText(/keyword.*isn't evidenced|keywords aren't evidenced/i));
  }

  function openProfileExperience() {
    fireEvent.click(screen.getByText(/keyword.*profile evidence absent from this resume/i));
  }

  it('renders nothing when the posting yielded no keywords, rather than an empty report that reads as a clean bill', () => {
    const { container } = render(<CoverageReport coverage={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('counts the uncovered keywords on the closed report, so the part worth acting on is never silent', () => {
    // The gap list is two clicks down. A heading that gave no reason to take either would leave the
    // one actionable half of this report unread by anyone who did not already know it was there.
    render(<CoverageReport coverage={[missing, inSkills]} />);

    expect(screen.getByText('1 not evidenced')).toBeVisible();
  });

  it('counts Profile evidence absent from this resume as not evidenced by this resume', () => {
    render(<CoverageReport coverage={[profileExperience, inSkills]} />);

    expect(screen.getByText('1 not evidenced')).toBeVisible();
  });

  it('counts Profile-only keywords rather than claiming each keyword came from a different bullet', () => {
    render(
      <CoverageReport
        coverage={[profileExperience, { ...profileExperience, keyword: 'Terraform' }]}
      />,
    );
    openReport();

    expect(
      screen.getByText('2 keywords have Profile evidence absent from this resume'),
    ).toBeVisible();
  });

  it('says nothing about coverage when there is no gap, rather than a count that reads as a score', () => {
    render(<CoverageReport coverage={[inSkills, inExperience]} />);

    expect(screen.queryByText(/not evidenced/i)).toBeNull();
  });

  it('keeps uncovered keywords in their own collapsed group inside the report', () => {
    render(<CoverageReport coverage={[missing, inSkills]} />);

    expect(reportSummary()).toBeVisible();
    expect(screen.getByText('Kubernetes')).not.toBeVisible();

    openReport();

    expect(screen.getByText(/1 keyword isn't evidenced/i)).toBeVisible();
    expect(screen.getByText('Kubernetes')).not.toBeVisible();

    openMissingKeywords();

    expect(screen.getByText('Kubernetes')).toBeVisible();
  });

  it('keeps the evidenced keywords collapsed behind a count, so the report reads as a gap list and not a scorecard', () => {
    render(<CoverageReport coverage={[inSkills, inExperience]} />);
    openReport();

    expect(screen.queryByText('Redis')).not.toBeVisible();
    expect(screen.getByText(/1 in your skills/)).toBeVisible();
    expect(screen.getByText(/1 in your experience/)).toBeVisible();
  });

  it('shows the bullet a keyword was found in once the experience group is opened, so the claim is checkable', () => {
    render(<CoverageReport coverage={[inExperience]} />);
    openReport();

    fireEvent.click(screen.getByText(/1 in your experience/));

    expect(screen.getByText(inExperience.evidence!)).toBeVisible();
  });

  it('points an uncovered keyword at the profile, never at the resume — a keyword the profile cannot support must not be written onto one', () => {
    render(<CoverageReport coverage={[missing]} />);
    openReport();
    openMissingKeywords();

    expect(screen.getByText(/add it to your profile/i)).toBeVisible();
    expect(screen.queryByText(/add .* to your resume/i)).toBeNull();
  });

  it('shows Profile-only evidence and tells the candidate to star it instead of adding a fact', () => {
    render(<CoverageReport coverage={[profileExperience]} />);
    openReport();
    openProfileExperience();

    expect(screen.getByText(profileExperience.evidence!)).toBeVisible();
    expect(screen.getByText(/star a listed source bullet/i)).toBeVisible();
    expect(screen.queryByText(/add it to your profile/i)).toBeNull();
  });

  it('opens the options page from the gap list, which is where the gap is actually fixed', () => {
    const { openOptionsPage } = fakeChrome();
    render(<CoverageReport coverage={[missing]} />);
    openReport();
    openMissingKeywords();

    fireEvent.click(screen.getByRole('button', { name: /edit your profile/i }));

    expect(openOptionsPage).toHaveBeenCalled();
  });

  it('omits a group nothing falls into, so an empty heading never implies a gap that does not exist', () => {
    render(<CoverageReport coverage={[inSkills]} />);
    openReport();

    expect(screen.queryByText(/not evidenced/i)).toBeNull();
    expect(screen.queryByText(/in your experience/)).toBeNull();
  });
});
