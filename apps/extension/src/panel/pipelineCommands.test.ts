/**
 * The three commands, and the two things that are only true of them here: each pairs its message
 * with the optimistic status it raises, and each names the run it is about.
 *
 * The Autofill Tab's own tests drive these through its buttons, which is where the *eligibility*
 * rules live. What that surface cannot reach is the state before Chrome has named a tab — the
 * Analyze button is rendered and enabled there, since whether it is enabled depends on the Job
 * Description rather than on the tab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from '../lib/fakeChrome';
import { typedMessageEnvelope } from '../lib/messages';
import type { PipelineRunState, RunStep } from '../lib/run';
import { pipelineCommands } from './pipelineCommands';
import type { ActiveRun } from './useActiveRun';
import type { JobDescription } from './useJobDescription';
import { profile } from '../lib/testFixtures';

const JOB_URL = 'https://boards.greenhouse.io/acme/jobs/1';

/** Records which step each command raised, which is the half a message assertion can't see. */
let raised: RunStep[];

function activeRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    tabId: 1,
    tabUrl: JOB_URL,
    changeToken: 0,
    run: { runId: 'run-1' } as PipelineRunState,
    status: 'review',
    review: { pill: null, canReview: true, outcome: null, notices: [] },
    beginCommand: vi.fn((step: RunStep) => {
      raised.push(step);
      return vi.fn();
    }),
    edit: vi.fn(),
    updateAnswer: vi.fn(),
    updateTailoredResume: vi.fn(),
    ...overrides,
  };
}

function jobDescription(overrides: Partial<JobDescription> = {}): JobDescription {
  return {
    text: 'Senior Engineer at Acme...',
    source: 'manual',
    analysisUrl: JOB_URL,
    scrapeStatus: { kind: 'idle' },
    canScrape: true,
    edit: vi.fn(),
    scrape: vi.fn(),
    ...overrides,
  };
}

function commandsFor(run = activeRun(), description = jobDescription()) {
  return pipelineCommands(run, profile, description);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  raised = [];
});

describe('pipelineCommands', () => {
  it('starts the Analysis Step against the URL the description belongs to', () => {
    const { sendMessage } = fakeChrome();

    expect(commandsFor().analyze()).toBe(true);

    expect(raised).toEqual(['analysis']);
    expect(sendMessage).toHaveBeenCalledWith(
      typedMessageEnvelope({
        type: 'START_ANALYSIS',
        tabId: 1,
        tabUrl: JOB_URL,
        profile,
        jobDescription: 'Senior Engineer at Acme...',
        force: false,
      }),
      expect.any(Function),
    );
  });

  it('carries the Duplicate Guard override when the candidate insists', () => {
    const { sendMessage } = fakeChrome();

    commandsFor().analyze(true);

    expect(sendMessage.mock.calls[0]![0]!).toMatchObject({ payload: { force: true } });
  });

  it.each([
    ['fill', 'START_FILL', (c: ReturnType<typeof commandsFor>) => c.fill()],
    ['save', 'START_SAVE_APPLICATION', (c: ReturnType<typeof commandsFor>) => c.save()],
  ])('names the run %s is about, so a delayed command cannot claim another', (step, type, send) => {
    const { sendMessage } = fakeChrome();

    send(commandsFor());

    expect(raised).toEqual([step]);
    expect(sendMessage.mock.calls[0]![0]!).toMatchObject({
      payload: { type, expectedRunId: 'run-1' },
    });
  });

  /**
   * Before Chrome has named a tab there is nothing to address. The Analyze button is rendered and
   * enabled in that state — it is disabled on the Job Description, not on the tab — so this is a
   * reachable click rather than a defensive branch.
   */
  it('sends nothing, and raises no status, before Chrome has named a tab', () => {
    const { sendMessage } = fakeChrome();
    const commands = commandsFor(activeRun({ tabId: null }));

    expect(commands.analyze()).toBe(false);
    commands.fill();
    commands.save();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(raised).toEqual([]);
  });

  it('sends no Analysis Step for an empty or whitespace-only description', () => {
    const { sendMessage } = fakeChrome();

    expect(commandsFor(activeRun(), jobDescription({ text: '   ' })).analyze()).toBe(false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(raised).toEqual([]);
  });

  it('sends no Analysis Step when no URL has been settled to file it under', () => {
    const { sendMessage } = fakeChrome();

    expect(commandsFor(activeRun(), jobDescription({ analysisUrl: null })).analyze()).toBe(false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(raised).toEqual([]);
  });

  it('sends no Fill or Save with no run to name', () => {
    const { sendMessage } = fakeChrome();
    const commands = commandsFor(activeRun({ run: null }));

    commands.fill();
    commands.save();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(raised).toEqual([]);
  });

  /**
   * The pairing this module exists for: a command that Chrome could not deliver stands down the
   * status *it* raised, through the callback `beginCommand` handed out for that attempt. Held apart
   * — a `begin` here and a shared `fail` there — the two were nine loose facts the tab paired by
   * inspection, and a late failure could stand a newer command's status down.
   */
  it('stands the status it raised back down when Chrome cannot deliver the command', async () => {
    const undelivered = vi.fn();
    const run = activeRun({
      beginCommand: vi.fn((step) => {
        raised.push(step);
        return undelivered;
      }),
    });
    fakeChrome({
      sendMessage: (_message, callback) => {
        const runtime = chrome.runtime as { lastError?: { message: string } };
        runtime.lastError = { message: 'Could not establish connection.' };
        callback(undefined);
        delete runtime.lastError;
      },
    });

    commandsFor(run).fill();
    await vi.waitFor(() => expect(undelivered).toHaveBeenCalledOnce());

    expect(raised).toEqual(['fill']);
  });

  /**
   * The other way a command produces nothing to observe: Chrome delivered it, but
   * `background/runClaim.ts` refused the claim — another panel already running this step, or a
   * stale `expectedRunId`. Neither leaves a `chrome.storage.onChanged` event for the panel to learn
   * from, so this stands the optimistic status down exactly like an undelivered command does.
   */
  it('stands the status back down when the background refuses the claim', async () => {
    const undelivered = vi.fn();
    const run = activeRun({
      beginCommand: vi.fn((step) => {
        raised.push(step);
        return undelivered;
      }),
    });
    fakeChrome({
      sendMessage: (_message, callback) => {
        callback({ claimed: false, reason: 'busy' });
      },
    });

    commandsFor(run).save();
    await vi.waitFor(() => expect(undelivered).toHaveBeenCalledOnce());

    expect(raised).toEqual(['save']);
  });

  it('does not stand the status down when the claim succeeds', async () => {
    const undelivered = vi.fn();
    const run = activeRun({
      beginCommand: vi.fn((step) => {
        raised.push(step);
        return undelivered;
      }),
    });
    const { sendMessage } = fakeChrome({
      sendMessage: (_message, callback) => {
        callback({ claimed: true });
      },
    });

    commandsFor(run).fill();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    expect(undelivered).not.toHaveBeenCalled();
  });
});
