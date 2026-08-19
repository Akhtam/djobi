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
  workExperience: [],
  education: [],
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

    expect(onUseAnswer).toHaveBeenCalledWith('field-7', 'A short answer.');
  });

  it('starts a fresh thread when the same card is handed over again', async () => {
    // Same question, same draft: only the token differs, which is exactly why the token exists.
    stubChat({ reply: 'Shortened it.', revisedAnswer: 'A short answer.' });
    const { rerender } = render(
      <AskTab client={client} profile={profile} jobInfo={null} seed={seed} onUseAnswer={vi.fn()} />,
    );

    type('Shorter.');
    await waitFor(() => expect(screen.getByText('Shortened it.')).toBeTruthy());

    rerender(
      <AskTab
        client={client}
        profile={profile}
        jobInfo={null}
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
