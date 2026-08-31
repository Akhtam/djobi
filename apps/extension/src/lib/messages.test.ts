import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TYPED_MESSAGE_PROTOCOL,
  TYPED_MESSAGE_VERSION,
  TypedMessageEnvelopeSchema,
  TypedMessageSchema,
  notify,
  typedMessageEnvelope,
  type TypedMessage,
} from './messages';
import { profile } from './testFixtures';

describe('notify', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(), lastError: undefined } });
  });

  it('sends the message via chrome.runtime.sendMessage', () => {
    notify({ type: 'START_FILL', tabId: 1, profile, expectedRunId: 'run-1' });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      typedMessageEnvelope({
        type: 'START_FILL',
        tabId: 1,
        profile,
        expectedRunId: 'run-1',
      }),
      expect.any(Function),
    );
  });

  it('reads runtime.lastError, so sending with no service worker listening is not an unchecked error', () => {
    // Chrome only treats `lastError` as handled once it has been read; leaving it alone logs a
    // console error the caller can do nothing about. There is nothing else to assert here — the
    // property access *is* the behaviour.
    const read = vi.fn(() => ({ message: 'Could not establish connection.' }));
    // Invoke the callback the way an unanswered send does: with no argument.
    const sendMessage = vi.fn((_message: unknown, callback: () => void) => callback());
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    Object.defineProperty(chrome.runtime, 'lastError', { get: read, configurable: true });

    notify({ type: 'START_FILL', tabId: 1, profile, expectedRunId: 'run-1' });

    expect(read).toHaveBeenCalled();
  });

  it('reports an immediate delivery failure without adding a response to the protocol', () => {
    const onDispatchError = vi.fn();
    const sendMessage = vi.fn((_message: unknown, callback: () => void) => callback());
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, lastError: { message: 'Could not establish connection.' } },
    });

    notify({ type: 'START_FILL', tabId: 1, profile, expectedRunId: 'run-1' }, onDispatchError);

    expect(onDispatchError).toHaveBeenCalledWith('Could not establish connection.');
  });

  /**
   * `chrome.runtime.lastError` is sometimes present with an empty message. Passing that straight
   * through puts a blank line where the panel shows the cause, which reads as a failure with no
   * reason rather than one Chrome declined to explain.
   */
  it('names the failure itself when Chrome reports one with no message', () => {
    const onDispatchError = vi.fn();
    const sendMessage = vi.fn((_message: unknown, callback: () => void) => callback());
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: { message: '' } } });

    notify({ type: 'START_FILL', tabId: 1, profile, expectedRunId: 'run-1' }, onDispatchError);

    expect(onDispatchError).toHaveBeenCalledWith(
      'The background worker did not receive the command.',
    );
  });

  it('does not report a dispatch error when Chrome accepted the notification', () => {
    const onDispatchError = vi.fn();
    const sendMessage = vi.fn((_message: unknown, callback: () => void) => callback());
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });

    notify({ type: 'START_FILL', tabId: 1, profile, expectedRunId: 'run-1' }, onDispatchError);

    expect(onDispatchError).not.toHaveBeenCalled();
  });

  it('returns nothing — the protocol has no responses to wait on', () => {
    expect(
      notify({ type: 'START_FILL', tabId: 1, profile, expectedRunId: 'run-1' }),
    ).toBeUndefined();
  });
});

describe('typed-message protocol', () => {
  const messages: TypedMessage[] = [
    { type: 'REPORT_JOB_PAGE', fields: [] },
    {
      type: 'START_ANALYSIS',
      tabId: 1,
      tabUrl: 'https://example.com/jobs/1',
      profile,
      jobDescription: 'Senior Engineer',
    },
    { type: 'START_FILL', tabId: 1, profile, expectedRunId: 'run-1' },
    { type: 'START_SAVE_APPLICATION', tabId: 1, expectedRunId: 'run-1' },
    {
      type: 'UPDATE_RUN',
      tabId: 1,
      runId: 'run-1',
      updates: { answers: [], jobDescription: 'Senior Engineer' },
    },
    {
      type: 'UPDATE_JOB_CONTEXT',
      tabId: 1,
      tabUrl: 'https://example.com/jobs/1',
      jobDescription: 'Senior Engineer',
      source: 'manual',
    },
    { type: 'CHECK_RUN', tabId: 1 },
  ];

  it.each(messages)('parses $type from the versioned envelope', (message) => {
    expect(TypedMessageEnvelopeSchema.parse(typedMessageEnvelope(message)).payload).toEqual(
      message,
    );
  });

  it('rejects raw, wrong-version, unknown, and partial messages', () => {
    expect(TypedMessageEnvelopeSchema.safeParse({ type: 'CHECK_RUN', tabId: 1 }).success).toBe(
      false,
    );
    expect(
      TypedMessageEnvelopeSchema.safeParse({
        protocol: TYPED_MESSAGE_PROTOCOL,
        version: TYPED_MESSAGE_VERSION + 1,
        payload: { type: 'CHECK_RUN', tabId: 1 },
      }).success,
    ).toBe(false);
    expect(
      TypedMessageEnvelopeSchema.safeParse({
        protocol: TYPED_MESSAGE_PROTOCOL,
        version: TYPED_MESSAGE_VERSION,
        payload: { type: 'UNKNOWN', tabId: 1 },
      }).success,
    ).toBe(false);
    expect(
      TypedMessageEnvelopeSchema.safeParse({
        protocol: TYPED_MESSAGE_PROTOCOL,
        version: TYPED_MESSAGE_VERSION,
        payload: { type: 'START_FILL', tabId: 1 },
      }).success,
    ).toBe(false);
  });

  it('applies shared nested defaults while parsing', () => {
    const parsed = TypedMessageSchema.parse({
      type: 'REPORT_JOB_PAGE',
      fields: [
        {
          id: 'email',
          label: 'Email',
          inputType: 'email',
          selector: '#email',
          category: 'email',
        },
      ],
    });

    expect(parsed).toMatchObject({
      fields: [{ required: false, elementRole: 'native' }],
    });
  });
});
