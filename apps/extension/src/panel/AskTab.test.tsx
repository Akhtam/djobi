/**
 * The Ask tab, driven through the same `BackendClient` seam the rest of the panel's tests use.
 *
 * The cases worth pinning are the ones where the two flows this one component serves could drift
 * apart: what a cold ask sends versus what a seeded refinement sends, and which of the two offers
 * to write an answer back.
 *
 * Everything is typed into the one composer, as in the UI — including the question, which is what
 * a cold ask's first message is. `type()` is that composer, so a test reads the way the tab is used.
 */
import type { JobInfo, Profile } from '@djobi/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBackendClient, type BackendClient } from '../lib/backendClient';
import { AskTab, type AskSeed } from './AskTab';

/** The one operation this tab performs, spied on and answered from memory. */
let answerChat: ReturnType<typeof vi.fn>;
let client: BackendClient;

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  projects: [],
  certifications: [],
  awards: [],
  skills: ['TypeScript'],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Engineer',
  seniority: 'Senior',
  location: null,
  requirements: [],
  keywords: [],
};

const seed: AskSeed = {
  runId: 'run-1',
  fieldId: 'field-7',
  question: 'Tell us about a challenge you faced.',
  currentAnswer: 'A long-winded first draft.',
  token: 1,
};

/** Every turn this tab asked for, in order — what it asked, not which URL it used. */
function chatCalls(): Record<string, unknown>[] {
  return answerChat.mock.calls.map(([turn]) => turn as Record<string, unknown>);
}

/** Answers successive turns with `replies`, repeating the last one. */
function stubChat(...replies: { reply: string; revisedAnswer?: string }[]) {
  let index = 0;
  answerChat = vi.fn(async () => replies[Math.min(index++, replies.length - 1)]);
  client = createFakeBackendClient({ answerChat } as Partial<BackendClient>);
}

/** A turn that fails, then succeeds — the retry path. */
function stubChatFailure(message: string, then: { reply: string; revisedAnswer?: string }) {
  let first = true;
  answerChat = vi.fn(async () => {
    if (first) {
      first = false;
      throw new Error(message);
    }
    return then;
  });
  client = createFakeBackendClient({ answerChat } as Partial<BackendClient>);
}

/** Types into the composer and sends it, the only way a turn is started in this tab. */
function type(message: string) {
  fireEvent.change(screen.getByLabelText(/Application question|Message/), {
    target: { value: message },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

function renderTab(overrides: Partial<Parameters<typeof AskTab>[0]> = {}) {
  const onUseAnswer = vi.fn();
  render(
    <AskTab
      client={client}
      profile={profile}
      jobInfo={null}
      activeRunId={overrides.seed?.runId ?? null}
      seed={null}
      onUseAnswer={onUseAnswer}
      {...overrides}
    />,
  );
  return { onUseAnswer };
}

beforeEach(() => {
  stubChat({ reply: 'Here you go.' });
});

describe('AskTab — a cold ask', () => {
  it('asks with an empty thread and no draft, and shows the answer it gets back', async () => {
    stubChat({ reply: 'Here is a draft.', revisedAnswer: 'I shipped the billing portal.' });
    renderTab({ jobInfo });

    type('Why do you want to work here?');

    await waitFor(() => expect(screen.getByText('Here is a draft.')).toBeTruthy());
    expect(screen.getByText('I shipped the billing portal.')).toBeTruthy();
    // The question is in the transcript, and in the request's `question` — never in its thread.
    expect(screen.getAllByText('Why do you want to work here?').length).toBeGreaterThan(0);
    expect(chatCalls()[0]).toMatchObject({
      question: 'Why do you want to work here?',
      jobInfo,
      messages: [],
    });
    // The tab asks with no draft; dropping the key on the wire is `httpBackendClient`'s job, and
    // is asserted where that adapter is tested.
    expect(chatCalls()[0].currentAnswer).toBeUndefined();
  });

  it('offers a copy button and no write-back, since there is no field to write to', async () => {
    stubChat({ reply: 'Here is a draft.', revisedAnswer: 'An answer.' });
    const { onUseAnswer } = renderTab();

    type('Why us?');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy answer' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Use this answer' })).toBeNull();
    expect(onUseAnswer).not.toHaveBeenCalled();
  });

  it("sends the assistant's turn back as the thread's opening turn on a follow-up", async () => {
    // The opening *user* turn of a cold ask is the backend's scaffold, never a message — so the
    // thread the panel holds starts with the assistant, and sending it any other way is a 400.
    stubChat(
      { reply: 'Here is a draft.', revisedAnswer: 'An answer.' },
      { reply: 'Shorter now.', revisedAnswer: 'Short.' },
    );
    renderTab();

    type('Why us?');
    await waitFor(() => expect(screen.getByText('Here is a draft.')).toBeTruthy());

    type('Make it shorter.');

    await waitFor(() => expect(screen.getByText('Shorter now.')).toBeTruthy());
    expect(chatCalls()[1].messages).toEqual([
      { role: 'assistant', content: 'Here is a draft.' },
      { role: 'user', content: 'Make it shorter.' },
    ]);
  });

  it('keeps the job it started with when the browser tab moves under it', async () => {
    // The panel's `jobInfo` follows the active browser tab. A seeded thread always captured its
    // job; a cold one read the live prop on every turn, so a conversation that began about one
    // posting silently grounded its second answer in another.
    stubChat(
      { reply: 'Here is a draft.', revisedAnswer: 'An answer.' },
      { reply: 'Shorter now.', revisedAnswer: 'Short.' },
    );
    const otherJob: JobInfo = { ...jobInfo, company: 'Globex', roleTitle: 'Staff Engineer' };
    const { rerender } = render(
      <AskTab
        client={client}
        profile={profile}
        jobInfo={jobInfo}
        activeRunId={null}
        seed={null}
        onUseAnswer={vi.fn()}
      />,
    );

    type('Why us?');
    await waitFor(() => expect(screen.getByText('Here is a draft.')).toBeTruthy());

    rerender(
      <AskTab
        client={client}
        profile={profile}
        jobInfo={otherJob}
        activeRunId={null}
        seed={null}
        onUseAnswer={vi.fn()}
      />,
    );
    type('Make it shorter.');

    await waitFor(() => expect(screen.getByText('Shorter now.')).toBeTruthy());
    expect(chatCalls()[1]).toMatchObject({ jobInfo });
  });

  it('abandons the conversation and returns to the empty state on "New question"', async () => {
    stubChat({ reply: 'Here is a draft.', revisedAnswer: 'An answer.' });
    renderTab();

    type('Why us?');
    await waitFor(() => expect(screen.getByText('Here is a draft.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'New question' }));

    expect(screen.getByPlaceholderText(/Paste the question/)).toBeTruthy();
    expect(screen.queryByText('Here is a draft.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New question' })).toBeNull();
  });

  /**
   * A hand-off resets the thread while a turn may still be in flight — unlike "New question", which
   * is disabled then. The answer that arrives afterwards belongs to a conversation the candidate
   * has left, and appending it would put one question's answer under another's.
   */
  it('drops an answer that arrives for a thread a hand-off has already replaced', async () => {
    let answerTurn!: (reply: { reply: string; revisedAnswer?: string }) => void;
    answerChat = vi.fn(
      () =>
        new Promise((resolve) => {
          answerTurn = resolve as typeof answerTurn;
        }),
    );
    client = createFakeBackendClient({ answerChat } as Partial<BackendClient>);
    const { rerender } = render(
      <AskTab
        client={client}
        profile={profile}
        jobInfo={null}
        activeRunId={seed.runId}
        seed={null}
        onUseAnswer={vi.fn()}
      />,
    );

    type('Why us?');
    await waitFor(() => expect(answerChat).toHaveBeenCalled());

    rerender(
      <AskTab
        client={client}
        profile={profile}
        jobInfo={null}
        activeRunId={seed.runId}
        seed={seed}
        onUseAnswer={vi.fn()}
      />,
    );
    answerTurn({ reply: 'An answer nobody is waiting for.', revisedAnswer: 'Stale.' });

    await waitFor(() =>
      expect(screen.getByText('Tell us about a challenge you faced.')).toBeTruthy(),
    );
    expect(screen.queryByText('An answer nobody is waiting for.')).toBeNull();
  });

  it('marks the turn that was copied, not every turn that produced the same answer', async () => {
    // Copy state was keyed by the answer's text. Two turns can land on the same answer — asking for
    // a change and then asking to put it back is the ordinary way — and both then read "Copied".
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    stubChat(
      { reply: 'Here is a draft.', revisedAnswer: 'The same answer.' },
      { reply: 'Back as it was.', revisedAnswer: 'The same answer.' },
    );
    renderTab();

    type('Why us?');
    await waitFor(() => expect(screen.getByText('Here is a draft.')).toBeTruthy());
    type('Put it back.');
    await waitFor(() => expect(screen.getByText('Back as it was.')).toBeTruthy());

    const copyButtons = screen.getAllByRole('button', { name: /Copy answer|Copied/ });
    expect(copyButtons).toHaveLength(2);
    fireEvent.click(copyButtons[0]);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Copied' })).toHaveLength(1));
    expect(screen.getAllByRole('button', { name: 'Copy answer' })).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe('AskTab — a seeded refinement', () => {
  it('opens on the seeded question and draft, and sends both with the first instruction', async () => {
    stubChat({ reply: 'Shortened it.', revisedAnswer: 'A short answer.' });
    renderTab({ seed, jobInfo });

    expect(screen.getByText('Tell us about a challenge you faced.')).toBeTruthy();
    expect(screen.getByText('A long-winded first draft.')).toBeTruthy();

    type('Make it shorter.');

    await waitFor(() => expect(screen.getByText('Shortened it.')).toBeTruthy());
    expect(chatCalls()[0]).toMatchObject({
      question: 'Tell us about a challenge you faced.',
      currentAnswer: 'A long-winded first draft.',
      messages: [{ role: 'user', content: 'Make it shorter.' }],
    });
  });

  it('writes the answer back to the field the thread was seeded from', async () => {
    stubChat({ reply: 'Shortened it.', revisedAnswer: 'A short answer.' });
    const { onUseAnswer } = renderTab({ seed });

    type('Shorter.');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use this answer' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use this answer' }));

    // The run travels with the answer: `useActiveRun.updateAnswer` refuses a write meant for a run
    // the panel is no longer showing, which a render-time check alone cannot do.
    expect(onUseAnswer).toHaveBeenCalledWith(seed.runId, 'field-7', 'A short answer.');
  });

  it('starts a fresh thread when the same card is handed over again', async () => {
    // Same question, same draft: only the token differs, which is exactly why the token exists.
    stubChat({ reply: 'Shortened it.', revisedAnswer: 'A short answer.' });
    const { rerender } = render(
      <AskTab
        client={client}
        profile={profile}
        jobInfo={null}
        activeRunId={seed.runId}
        seed={seed}
        onUseAnswer={vi.fn()}
      />,
    );

    type('Shorter.');
    await waitFor(() => expect(screen.getByText('Shortened it.')).toBeTruthy());

    rerender(
      <AskTab
        client={client}
        profile={profile}
        jobInfo={null}
        activeRunId={seed.runId}
        seed={{ ...seed, token: 2 }}
        onUseAnswer={vi.fn()}
      />,
    );

    expect(screen.queryByText('Shortened it.')).toBeNull();
  });

  it('shows a conversational turn with nothing to apply', async () => {
    stubChat({ reply: 'Which of your two projects should this be about?' });
    renderTab({ seed });

    type('Make it more specific.');

    await waitFor(() =>
      expect(screen.getByText('Which of your two projects should this be about?')).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Use this answer' })).toBeNull();
  });

  it('does not apply a seeded answer after the active browser tab changes runs', async () => {
    stubChat({ reply: 'Shortened it.', revisedAnswer: 'A short answer.' });
    const onUseAnswer = vi.fn();
    const view = render(
      <AskTab
        client={client}
        profile={profile}
        jobInfo={jobInfo}
        activeRunId={seed.runId}
        seed={seed}
        onUseAnswer={onUseAnswer}
      />,
    );

    type('Shorter.');
    await screen.findByRole('button', { name: 'Use this answer' });

    view.rerender(
      <AskTab
        client={client}
        profile={profile}
        jobInfo={null}
        activeRunId="run-2"
        seed={seed}
        onUseAnswer={onUseAnswer}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Use this answer' })).toBeNull();
    expect(screen.getByText(/switch back to the application/i)).toBeInTheDocument();
    expect(onUseAnswer).not.toHaveBeenCalled();
  });
});

describe('AskTab — failures', () => {
  it('names the failure and retries the same turn without duplicating it in the thread', async () => {
    stubChatFailure('POST /answer-chat failed (500): model unavailable', {
      reply: 'Second time lucky.',
      revisedAnswer: 'An answer.',
    });
    renderTab({ seed });

    type('Shorter.');

    await waitFor(() =>
      expect(screen.getByText('POST /answer-chat failed (500): model unavailable')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByText('Second time lucky.')).toBeTruthy());
    expect(chatCalls()[1].messages).toEqual([{ role: 'user', content: 'Shorter.' }]);
    expect(screen.getAllByText('Shorter.')).toHaveLength(1);
  });

  it('will not send an empty composer', () => {
    renderTab();

    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });

  it('sends on Enter, and breaks the line on Shift+Enter', async () => {
    stubChat({ reply: 'Here is a draft.', revisedAnswer: 'An answer.' });
    renderTab();

    const composer = screen.getByLabelText('Application question');
    fireEvent.change(composer, { target: { value: 'Why us?' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(chatCalls()).toHaveLength(0);

    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(chatCalls()).toHaveLength(1));
    expect(chatCalls()[0]).toMatchObject({ question: 'Why us?', messages: [] });
  });
});
