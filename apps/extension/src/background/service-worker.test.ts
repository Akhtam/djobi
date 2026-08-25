import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockHandleTypedMessage, mockRecover, mockRegisterCleanup } = vi.hoisted(() => ({
  mockHandleTypedMessage: vi.fn(),
  mockRecover: vi.fn(),
  mockRegisterCleanup: vi.fn(),
}));

vi.mock('../lib/tabStore', () => ({
  recoverInterruptedPipelineRuns: mockRecover,
  registerTabStateCleanup: mockRegisterCleanup,
}));
vi.mock('./router', () => ({ handleTypedMessage: mockHandleTypedMessage }));

describe('service worker dispatch', () => {
  let listener: (message: unknown, sender: chrome.runtime.MessageSender) => void;
  let resolveRecovery: () => void;

  beforeEach(async () => {
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
          addListener: vi.fn(
            (registered: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
              listener = registered;
            },
          ),
        },
      },
      sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    });

    await import('./service-worker');
  });

  it('registers synchronously but gates a waking message behind the one-time recovery sweep', async () => {
    const message = { type: 'START_SAVE_APPLICATION', tabId: 7 };

    expect(listener(message, {} as chrome.runtime.MessageSender)).toBeUndefined();
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

    const returned = listener({ type: 'START_FILL', tabId: 9 }, {} as chrome.runtime.MessageSender);

    expect(returned).toBeUndefined();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        '[djobi] background message failed',
        expect.objectContaining({ type: 'START_FILL', tabId: 9, error: failure }),
      ),
    );
  });
});
