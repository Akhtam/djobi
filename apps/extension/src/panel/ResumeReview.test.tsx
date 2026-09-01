import type { Profile, TailoredResume } from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResumeReview } from './ResumeReview';

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [
    {
      company: 'Acme Corp',
      title: 'Senior Software Engineer',
      startDate: '2022-01',
      endDate: null,
      bullets: [
        'Led the billing service migration off the legacy vendor',
        'Owned the on-call rotation',
      ],
      maxBullets: null,
      starredIndices: [],
      suppressIfEmpty: false,
    },
  ],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  skills: ['TypeScript'],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

function resume(bullets: string[]): TailoredResume {
  return {
    skills: profile.skills,
    workExperience: [
      {
        company: 'Acme Corp',
        title: 'Senior Software Engineer',
        startDate: '2022-01',
        endDate: null,
        bullets,
      },
    ],
  };
}

describe('ResumeReview', () => {
  it('stays visible, open, and warns the candidate when no bullets remain to review', () => {
    render(
      <ResumeReview tailoredResume={resume([])} profile={profile} editable onChange={vi.fn()} />,
    );

    // No click to expand: this is exactly the case where the candidate must not have to go looking
    // for it before Fill attaches a resume with no experience bullets at all.
    expect(screen.getByText(/No resume bullets remain/)).toBeVisible();
  });

  it('shows a verbatim bullet with no "originally" line, since there is nothing to compare it to', () => {
    render(
      <ResumeReview
        tailoredResume={resume(['Owned the on-call rotation'])}
        profile={profile}
        editable
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Review resume bullets'));

    expect(screen.queryByText(/Originally:/)).toBeNull();
  });

  it('shows the matched Profile source and a revert control for a reworded bullet', () => {
    render(
      <ResumeReview
        tailoredResume={resume(['Led a billing service migration away from the legacy vendor'])}
        profile={profile}
        editable
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Review resume bullets'));

    expect(
      screen.getByText(/Originally: Led the billing service migration off the legacy vendor/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Revert to original' })).toBeVisible();
  });

  it('reverts a bullet to its matched source text, verbatim, on click', () => {
    const onChange = vi.fn();
    render(
      <ResumeReview
        tailoredResume={resume(['Led a billing service migration away from the legacy vendor'])}
        profile={profile}
        editable
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Review resume bullets'));
    fireEvent.click(screen.getByRole('button', { name: 'Revert to original' }));

    expect(onChange).toHaveBeenCalledWith(
      resume(['Led the billing service migration off the legacy vendor']),
    );
  });

  it('edits a bullet inline and reports the whole edited resume', () => {
    const onChange = vi.fn();
    render(
      <ResumeReview
        tailoredResume={resume(['Owned the on-call rotation'])}
        profile={profile}
        editable
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Review resume bullets'));
    fireEvent.change(screen.getByLabelText('Role 1 bullet 1'), {
      target: { value: 'Owned the on-call rotation for the payments team' },
    });

    expect(onChange).toHaveBeenCalledWith(
      resume(['Owned the on-call rotation for the payments team']),
    );
  });

  it('removes a bullet on click', () => {
    const onChange = vi.fn();
    render(
      <ResumeReview
        tailoredResume={resume(['First bullet', 'Second bullet'])}
        profile={profile}
        editable
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Review resume bullets'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove role 1 bullet 1' }));

    expect(onChange).toHaveBeenCalledWith(resume(['Second bullet']));
  });

  it('moves a bullet down, and the one before it up, on click', () => {
    const onChange = vi.fn();
    render(
      <ResumeReview
        tailoredResume={resume(['First bullet', 'Second bullet'])}
        profile={profile}
        editable
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Review resume bullets'));
    fireEvent.click(screen.getByRole('button', { name: 'Move role 1 bullet 1 down' }));

    expect(onChange).toHaveBeenCalledWith(resume(['Second bullet', 'First bullet']));
  });

  it('disables every control while not editable, without hiding the review', () => {
    render(
      <ResumeReview
        tailoredResume={resume(['Owned the on-call rotation'])}
        profile={profile}
        editable={false}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Review resume bullets'));

    expect(screen.getByLabelText('Role 1 bullet 1')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove role 1 bullet 1' })).toBeDisabled();
  });

  it('never offers to move the first bullet up or the last bullet down', () => {
    render(
      <ResumeReview
        tailoredResume={resume(['Only bullet'])}
        profile={profile}
        editable
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Review resume bullets'));

    expect(screen.getByRole('button', { name: 'Move role 1 bullet 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move role 1 bullet 1 down' })).toBeDisabled();
  });
});
