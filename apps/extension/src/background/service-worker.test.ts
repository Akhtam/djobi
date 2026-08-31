import { beforeEach, describe, expect, it, vi } from 'vitest';
import { typedMessageEnvelope } from '../lib/messages';

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
    const message = { type: 'START_SAVE_APPLICATION' as const, tabId: 7, expectedRunId: 'run-7' };
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
      typedMessageEnvelope({
        type: 'START_SAVE_APPLICATION',
        tabId: 9,
        expectedRunId: 'run-9',
      }),
      {} as chrome.runtime.MessageSender,
      vi.fn(),
    );

    expect(returned).toBeUndefined();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        '[djobi] background message failed',
        expect.objectContaining({ type: 'START_SAVE_APPLICATION', tabId: 9, error: failure }),
      ),
    );
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
