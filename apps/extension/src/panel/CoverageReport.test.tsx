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

describe('CoverageReport', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('renders nothing when the posting yielded no keywords, rather than an empty report that reads as a clean bill', () => {
    const { container } = render(<CoverageReport coverage={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows an uncovered keyword without needing to be opened — it is the only part worth acting on', () => {
    render(<CoverageReport coverage={[missing, inSkills]} />);

    expect(screen.getByText('Kubernetes')).toBeVisible();
  });

  it('keeps the evidenced keywords collapsed behind a count, so the report reads as a gap list and not a scorecard', () => {
    render(<CoverageReport coverage={[inSkills, inExperience]} />);

    expect(screen.queryByText('Redis')).not.toBeVisible();
    expect(screen.getByText(/1 in your skills/)).toBeVisible();
    expect(screen.getByText(/1 in your experience/)).toBeVisible();
  });

  it('shows the bullet a keyword was found in once the experience group is opened, so the claim is checkable', () => {
    render(<CoverageReport coverage={[inExperience]} />);

    fireEvent.click(screen.getByText(/1 in your experience/));

    expect(screen.getByText(inExperience.evidence!)).toBeVisible();
  });

  it('points an uncovered keyword at the profile, never at the resume — a keyword the profile cannot support must not be written onto one', () => {
    render(<CoverageReport coverage={[missing]} />);

    expect(screen.getByText(/add it to your profile/i)).toBeVisible();
    expect(screen.queryByText(/add .* to your resume/i)).toBeNull();
  });

  it('opens the options page from the gap list, which is where the gap is actually fixed', () => {
    const { openOptionsPage } = fakeChrome();
    render(<CoverageReport coverage={[missing]} />);

    fireEvent.click(screen.getByRole('button', { name: /edit your profile/i }));

    expect(openOptionsPage).toHaveBeenCalled();
  });

  it('omits a group nothing falls into, so an empty heading never implies a gap that does not exist', () => {
    render(<CoverageReport coverage={[inSkills]} />);

    expect(screen.queryByText(/not evidenced/i)).toBeNull();
    expect(screen.queryByText(/in your experience/)).toBeNull();
  });
});
