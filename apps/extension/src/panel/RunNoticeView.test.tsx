/**
 * The copy for each Run Notice, rendered directly.
 *
 * These used to be reachable only by driving a whole Application Pipeline run to the outcome that
 * produces each notice — `stubChrome`, render, Analyze, await, Fill, await, to assert one sentence.
 * The situation is `reviewOf`'s to decide and is tested there; what is asserted here is only the
 * wording and the action offered, which is what this module owns.
 */
import type { DetectedField } from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RunNotice } from '../lib/run';
import { RunNoticeView } from './RunNoticeView';

const noop = () => {};

describe('RunNoticeView', () => {
  it('names the past application and offers the override, on a duplicate', () => {
    const notice: RunNotice = {
      kind: 'duplicate',
      slot: 'outcome',
      tone: 'error',
      action: 'analyze-anyway',
      duplicate: {
        id: 'application-1',
        company: 'Acme',
        roleTitle: 'Staff Engineer',
        stage: 'phone_screen',
        createdAt: '2026-08-01T12:00:00.000Z',
        count: 1,
      },
    };
    const onAction = vi.fn();
    render(<RunNoticeView notice={notice} onAction={onAction} />);

    expect(screen.getByRole('status')).toHaveTextContent('You already applied to this job on');
    expect(screen.getByRole('status')).toHaveTextContent('Staff Engineer at Acme');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze and apply anyway' }));
    expect(onAction).toHaveBeenCalledWith('analyze-anyway');
  });

  it('counts repeat applications rather than reporting the same sentence twice', () => {
    const notice: RunNotice = {
      kind: 'duplicate',
      slot: 'outcome',
      tone: 'error',
      action: 'analyze-anyway',
      duplicate: {
        id: 'application-1',
        company: 'Acme',
        roleTitle: 'Staff Engineer',
        stage: 'applied',
        createdAt: '2026-08-01T12:00:00.000Z',
        count: 3,
      },
    };
    render(<RunNoticeView notice={notice} onAction={noop} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      "You've already applied to this job 3 times",
    );
  });

  /**
   * The two zero-filled outcomes are different problems with different advice — reload the page
   * versus fill it in by hand — which is the distinction most at risk of being flattened.
   */
  it('tells the candidate to reload when no fields were found at all', () => {
    render(
      <RunNoticeView
        notice={{ kind: 'no-fields-detected', slot: 'outcome', tone: 'error' }}
        onAction={noop}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('no form fields were found on this page');
    expect(screen.getByRole('alert')).toHaveTextContent('reload the page and try again');
  });

  it('tells the candidate to fill it by hand when the form was found but kept nothing', () => {
    render(
      <RunNoticeView
        notice={{ kind: 'nothing-filled', slot: 'outcome', tone: 'error', detectedFieldCount: 4 }}
        onAction={noop}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("this page's form was found (4 fields)");
    expect(alert).toHaveTextContent("You'll need to fill it in yourself");
    expect(alert).not.toHaveTextContent('reload');
  });

  it('says field, not fields, for a single detected field', () => {
    render(
      <RunNoticeView
        notice={{ kind: 'nothing-filled', slot: 'outcome', tone: 'error', detectedFieldCount: 1 }}
        onAction={noop}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('(1 field)');
  });

  it('lists the required fields that did not take a value', () => {
    const unresolved = [
      { id: 'f1', label: 'Work authorization', category: 'question' },
      { id: 'f2', label: '', category: 'phone' },
    ] as DetectedField[];
    render(
      <RunNoticeView
        notice={{
          kind: 'fill-incomplete',
          slot: 'outcome',
          tone: 'error',
          unresolvedRequiredFields: unresolved,
        }}
        onAction={noop}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent("2 required fields didn't take a value");
    // A field with no label falls back to its category rather than rendering an empty bullet.
    expect(screen.getByText('Work authorization')).toBeInTheDocument();
    expect(screen.getByText('phone')).toBeInTheDocument();
  });

  it('reports a successful fill with its count', () => {
    render(
      <RunNoticeView
        notice={{ kind: 'fill-complete', slot: 'outcome', tone: 'success', filledFieldCount: 1 }}
        onAction={noop}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Filled 1 field.');
  });

  /**
   * The same `RunFailureKind` reads differently per step, because what may have half-happened
   * differs: a Fill may have written to the page, a Save may already have recorded the Application.
   */
  it('warns that the page may be half-filled on a temporary fill failure', () => {
    const onAction = vi.fn();
    render(
      <RunNoticeView
        notice={{
          kind: 'fill-failed',
          slot: 'inline',
          tone: 'error',
          action: 'retry-fill',
          reason: 'temporary',
        }}
        onAction={onAction}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The form may have been partially filled');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onAction).toHaveBeenCalledWith('retry-fill');
  });

  it('warns that the Application may already exist on a temporary save failure', () => {
    const onAction = vi.fn();
    render(
      <RunNoticeView
        notice={{
          kind: 'save-failed',
          slot: 'inline',
          tone: 'error',
          action: 'retry-save',
          reason: 'temporary',
        }}
        onAction={onAction}
      />,
    );

    // Same `RunFailureKind`, different advice — checking the Dashboard, not the page.
    expect(screen.getByRole('alert')).toHaveTextContent('The save may have completed');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onAction).toHaveBeenCalledWith('retry-save');
  });

  it('sends a signed-out candidate to the options page rather than reporting a generic failure', () => {
    render(
      <RunNoticeView
        notice={{
          kind: 'analyze-failed',
          slot: 'outcome',
          tone: 'error',
          action: 'retry-analysis',
          reason: 'unauthorized',
        }}
        onAction={noop}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'You have been signed out. Sign in again from the extension options',
    );
  });

  it('names the backend as the thing to check when it is unreachable', () => {
    render(
      <RunNoticeView
        notice={{
          kind: 'analyze-failed',
          slot: 'outcome',
          tone: 'error',
          action: 'retry-analysis',
          reason: 'backend-unreachable',
        }}
        onAction={noop}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('could not reach its backend');
  });
});
