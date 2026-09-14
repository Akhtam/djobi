import { beforeEach, describe, expect, it, vi } from 'vitest';
import { typedMessageEnvelope } from '../lib/messages';
import { profile } from '../lib/testFixtures';

const { mockHandleTypedMessage, mockRecover, mockRegisterCleanup } = vi.hoisted(() => ({
  mockHandleTypedMessage: vi.fn(),
  mockRecover: vi.fn(),
  mockRegisterCleanup: vi.fn(),
}));

vi.mock('../lib/tabStore/pipelineRun', () => ({
  recoverInterruptedPipelineRuns: mockRecover,
}));
vi.mock('../lib/tabStore/lifecycle', () => ({
  registerTabStateCleanup: mockRegisterCleanup,
}));
vi.mock('./router', () => ({ handleTypedMessage: mockHandleTypedMessage }));

describe('service worker dispatch', () => {
  let listener: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => void;
  let resolveRecovery: () => void;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockHandleTypedMessage.mockReset();
    mockHandleTypedMessage.mockResolvedValue(undefined);
    mockRecover.mockReset();
    mockRegisterCleanup.mockReset();

    mockRecover.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      }),
    );

    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn((registered: typeof listener) => {
            listener = registered;
          }),
        },
      },
      sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    });

    await import('./service-worker');
  });

  it('registers synchronously but gates a waking message behind the one-time recovery sweep', async () => {
    const message = { type: 'CHECK_RUN' as const, tabId: 7 };
    const sendResponse = vi.fn();

    expect(
      listener(typedMessageEnvelope(message), {} as chrome.runtime.MessageSender, sendResponse),
    ).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith();
    expect(mockHandleTypedMessage).not.toHaveBeenCalled();

    resolveRecovery();
    await vi.waitFor(() => expect(mockHandleTypedMessage).toHaveBeenCalledWith(message, {}));
  });

  it('logs a routed task rejection without returning its promise to Chrome', async () => {
    const failure = new Error('storage write failed');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockHandleTypedMessage.mockRejectedValue(failure);
    resolveRecovery();
    await Promise.resolve();

    const returned = listener(
      typedMessageEnvelope({ type: 'CHECK_RUN', tabId: 9 }),
      {} as chrome.runtime.MessageSender,
      vi.fn(),
    );

    expect(returned).toBeUndefined();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        '[djobi] background message failed',
        expect.objectContaining({ type: 'CHECK_RUN', tabId: 9, error: failure }),
      ),
    );
  });

  describe('START_FILL and START_SAVE_APPLICATION, the other messages with a real reply', () => {
    const fill = { type: 'START_FILL' as const, tabId: 5, profile, expectedRunId: 'run-5' };

    it("keeps the channel open and answers with the claim's own verdict", async () => {
      mockHandleTypedMessage.mockResolvedValue({ claimed: false, reason: 'busy' });
      resolveRecovery();
      const sendResponse = vi.fn();

      expect(
        listener(typedMessageEnvelope(fill), {} as chrome.runtime.MessageSender, sendResponse),
      ).toBe(true);

      await vi.waitFor(() =>
        expect(sendResponse).toHaveBeenCalledWith({ claimed: false, reason: 'busy' }),
      );
    });

    it('reports a refusal after a routing failure, same as UPDATE_RUN does', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockHandleTypedMessage.mockRejectedValue(new Error('storage write failed'));
      resolveRecovery();
      const sendResponse = vi.fn();

      listener(typedMessageEnvelope(fill), {} as chrome.runtime.MessageSender, sendResponse);

      await vi.waitFor(() =>
        expect(sendResponse).toHaveBeenCalledWith({ claimed: false, reason: 'busy' }),
      );
      expect(error).toHaveBeenCalledOnce();
    });
  });

  describe('UPDATE_RUN', () => {
    const edit = {
      type: 'UPDATE_RUN' as const,
      tabId: 3,
      runId: 'run-3',
      updates: { answers: [], jobDescription: 'edited' },
    };

    it("keeps the channel open and answers with the store's own verdict", async () => {
      mockHandleTypedMessage.mockResolvedValue({ applied: false });
      resolveRecovery();
      const sendResponse = vi.fn();

      // `true` is what tells Chrome not to tear the channel down at this listener's return.
      expect(
        listener(typedMessageEnvelope(edit), {} as chrome.runtime.MessageSender, sendResponse),
      ).toBe(true);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ applied: false }));
    });

    /**
     * Answering a channel the panel already closed throws ("Attempting to use a disconnected
     * port"). That is a benign close, not a routing failure: letting it reach the `.catch` logged an
     * error for it and then called `sendResponse` a second time — throwing again, inside the catch
     * handler, with nothing left downstream to catch it.
     */
    it('swallows the throw from a panel that closed while the write was in flight', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockHandleTypedMessage.mockResolvedValue({ applied: true });
      resolveRecovery();
      const sendResponse = vi.fn(() => {
        throw new Error('Attempting to use a disconnected port object');
      });

      listener(typedMessageEnvelope(edit), {} as chrome.runtime.MessageSender, sendResponse);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());
      // Answered once, not twice, and a closed panel is not reported as a failure.
      expect(sendResponse).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
    });

    it('reports a refusal after a routing failure, and survives a closed channel there too', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockHandleTypedMessage.mockRejectedValue(new Error('storage write failed'));
      resolveRecovery();
      const sendResponse = vi.fn(() => {
        throw new Error('Attempting to use a disconnected port object');
      });

      listener(typedMessageEnvelope(edit), {} as chrome.runtime.MessageSender, sendResponse);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ applied: false }));
      expect(error).toHaveBeenCalledOnce();
    });
  });

  it.each([
    null,
    { type: 'CHECK_RUN', tabId: 7 },
    {
      protocol: 'djobi/typed-message',
      version: 2,
      payload: { type: 'CHECK_RUN', tabId: 7 },
    },
    {
      protocol: 'djobi/typed-message',
      version: 1,
      payload: { type: 'START_FILL', tabId: 7 },
    },
  ])('acknowledges, logs once, and drops malformed input %#', (input) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendResponse = vi.fn();

    expect(() => listener(input, { tab: { id: 7 } } as never, sendResponse)).not.toThrow();

    expect(sendResponse).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[djobi] dropped invalid background message',
      expect.objectContaining({ tabId: 7, issues: expect.any(Array) }),
    );
    expect(mockHandleTypedMessage).not.toHaveBeenCalled();
  });
});
