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
});
