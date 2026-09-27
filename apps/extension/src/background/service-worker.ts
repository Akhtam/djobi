/**
 * MV3 background service worker. Registers `messageListener.ts` over `router.ts`, cleans up per-tab
 * session state on close/navigation (`lib/tabStore/lifecycle.ts`), and makes the toolbar icon open
 * the side panel.
 *
 * It owns the one-time recovery sweep every message waits behind: Chrome can stop a worker
 * mid-step, and the next one turns abandoned operations into retryable errors.
 */
import { registerTabStateCleanup } from '../lib/tabStore/lifecycle';
import { recoverInterruptedPipelineRuns } from '../lib/tabStore/pipelineRun';
import { typedMessageListener } from './messageListener';
import { handleTypedMessage } from './router';

registerTabStateCleanup();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Register synchronously, but route only after recovery — otherwise the sweep could read a status
// this same worker just wrote and demote live work as interrupted.
const recoveryReady = recoverInterruptedPipelineRuns().catch((error: unknown) => {
  console.error('[djobi] interrupted pipeline recovery failed', error);
});

chrome.runtime.onMessage.addListener(typedMessageListener(handleTypedMessage, recoveryReady));
