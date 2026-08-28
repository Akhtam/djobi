import type { RequirementFit } from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RequirementFitReport } from './RequirementFitReport';

const unmet: RequirementFit = {
  requirement: 'A PhD in distributed systems',
  verdict: 'unmet',
  evidence: null,
  note: 'Your profile lists no doctorate.',
};
const partial: RequirementFit = {
  requirement: '5+ years of Go',
  verdict: 'partial',
  evidence: 'Wrote the Go ingestion service',
  note: 'Your profile shows about two years.',
};
const met: RequirementFit = {
  requirement: 'Experience running Kubernetes',
  verdict: 'met',
  evidence: 'Migrated the fleet to Kubernetes',
  note: '',
};

describe('RequirementFitReport', () => {
  it('renders nothing when there is no assessment, since a failed one and a posting with no requirements say the same thing', () => {
    const { container } = render(<RequirementFitReport fit={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows unmet and partial requirements without being opened — they are what the candidate has to decide about', () => {
    render(<RequirementFitReport fit={[met, partial, unmet]} />);

    expect(screen.getByText(unmet.requirement)).toBeVisible();
    expect(screen.getByText(partial.requirement)).toBeVisible();
  });

  it('lists unmet requirements before partial ones, hardest news first', () => {
    render(<RequirementFitReport fit={[partial, unmet]} />);

    const shown = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(shown[0]).toContain(unmet.requirement);
    expect(shown[1]).toContain(partial.requirement);
  });

  it('shows the note explaining a shortfall, which is the part that says what is actually missing', () => {
    render(<RequirementFitReport fit={[unmet]} />);

    expect(screen.getByText(unmet.note)).toBeVisible();
  });

  it('collapses the met requirements behind a count, so the block reads as a shortfall list and not a scorecard', () => {
    render(<RequirementFitReport fit={[met]} />);

    expect(screen.getByText(/1 requirement your profile meets/)).toBeVisible();
    expect(screen.queryByText(met.requirement)).not.toBeVisible();
  });

  it('shows the profile text a met verdict rests on once opened, because a claim the candidate cannot check is not worth making', () => {
    render(<RequirementFitReport fit={[met]} />);

    fireEvent.click(screen.getByText(/1 requirement your profile meets/));

    expect(screen.getByText(met.evidence!)).toBeVisible();
  });

  it('says so plainly when nothing falls short, rather than leaving the block silently empty', () => {
    render(<RequirementFitReport fit={[met]} />);

    expect(screen.getByText(/nothing in this posting looks out of reach/i)).toBeVisible();
  });
});
