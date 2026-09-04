/**
 * `PostingLink` is the one place a stored `jobUrl` becomes an `href`, so it is the one place a
 * scheme that isn't http(s) would become a click away from running script on the dashboard's own
 * origin. `NewApplicationSchema` refuses one at the write boundary now, but rows written before
 * that are still in the database — hence a guard here, and a test for it here.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PostingLink } from './PostingLink';

describe('PostingLink', () => {
  it('links out to an http(s) posting', () => {
    render(<PostingLink jobUrl="https://acme.com/jobs/1" company="Acme" />);

    const link = screen.getByRole('link', { name: 'Open the Acme job posting in a new tab' });
    expect(link).toHaveAttribute('href', 'https://acme.com/jobs/1');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders no link at all for a scheme that is not http(s)', () => {
    render(<PostingLink jobUrl="javascript:alert(document.cookie)" company="Acme" />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Job posting unavailable')).toBeInTheDocument();
  });

  it('renders no link for a stored value that is not a URL', () => {
    render(<PostingLink jobUrl="acme.com/jobs/1" company="Acme" />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
