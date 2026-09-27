/**
 * The panel's test harness — one fake Chrome and one set of fixtures, shared by the shell's and the
 * Autofill Tab's tests. Not collected by vitest (no `.test.`) and not shipped.
 */
import type {
  DetectedField,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { productionDetection, type PipelineDeps } from '../background/applicationPipeline';
import { typedMessageListener } from '../background/messageListener';
import { handleTypedMessage } from '../background/router';
import {
  createFakeBackendClient,
  withSessionRecovery,
  type BackendClient,
} from '../lib/backendClient';
import { fakeChrome } from '../lib/fakeChrome';
import { jobInfo, profile, tailoredResume } from '../lib/testFixtures';
import { type FakeSessionStorage } from '../lib/fakeSessionStorage';
import { TypedMessageEnvelopeSchema } from '../lib/messages';
import type { DuplicateApplication } from '../lib/run';
import { reportDetectedPage } from '../lib/tabStore/detectedPage';
import { getPipelineRun } from '../lib/tabStore/pipelineRun';

/** Re-exported so a panel test reaches for one module rather than two. */
export { jobInfo, profile, tailoredResume };

export const questionField: DetectedField = {
  id: 'f-why',
  label: 'Why do you want to work here?',
  inputType: 'textarea',
  selector: '#why-field',
  category: 'question',
  // Required, because the Analysis Step only drafts required questions — an optional one is left
  // for the candidate, and a fixture marked optional would never reach the review list at all.
  required: true,
  elementRole: 'native',
};

export const answers: QuestionAnswer[] = [
  {
    fieldId: 'f-why',
    question: 'Why do you want to work here?',
    answer: 'Draft answer.',
    sourceStoryIds: [],
  },
];

export const emailField: DetectedField = {
  id: 'f-email',
  label: 'Email',
  inputType: 'email',
  selector: '#email-field',
  category: 'email',
  required: false,
  elementRole: 'native',
};

export const nameField: DetectedField = {
  id: 'f-name',
  label: 'Full name',
  inputType: 'text',
  selector: '#name-field',
  category: 'full_name',
  required: false,
  elementRole: 'native',
};

// Three fillable fields, so a successful Fill Step reports "Filled 3 fields" — a count the real
// Fill Step now derives from these, rather than one the stub asserts into the store by hand.
export const jobPageData = {
  fields: [questionField, emailField, nameField],
};

/** The posting a test pastes in — the Analysis Step's only input now that nothing is scraped. */
export const JOB_DESCRIPTION = 'Senior Engineer at Acme, building the platform team.';

export interface StubOptions {
  tabUrl: string | null;
  tabId?: number;
  profile: Profile | null;
  /** Fail successive profile loads; `null` resolves with `profile`. The last entry repeats. */
  profileFailures?: (string | Error | null)[];
  jobPageData?: { fields: DetectedField[] } | null;
  /**
   * Share one `chrome.storage.session` across renders, simulating the panel closing and reopening.
   */
  sessionStorage?: FakeSessionStorage;
  /** Message to fail successive Analysis Steps with, `null` for success. The last entry repeats. */
  analysisFailures?: (string | Error | null)[];
  /** Same idea for the explicit Save Application action. */
  saveFailures?: (string | Error | null)[];
  /** Fail successive START-message deliveries before the service worker receives them. */
  dispatchFailures?: (string | null)[];
  /** Applications already saved for the tab's URL — what the duplicate guard on Analyze finds. */
  existingApplications?: Omit<DuplicateApplication, 'count'>[];
  /** If true, the Fill Step hangs at the page-filling call until `resolveFill()` is called —
   *  simulates a Fill Step still in flight in the background. */
  holdFill?: boolean;
  /** If true, the page answers that it kept none of the values — an ATS whose form model discards
   *  every programmatic write. */
  pageKeepsNothing?: boolean;
  /** If true, no frame answers the fill request, so its result cannot be verified. */
  pageDoesNotAnswer?: boolean;
  /** What `POST /answer-chat` returns for the Ask tab. */
  chatReply?: { reply: string; revisedAnswer?: string };
  /** The Tailored Resume preview's bytes — a promise a test can resolve or reject when it likes. */
  renderResumePdf?: () => Promise<ArrayBuffer>;
}

/** The entry for successive calls, repeating the last one once the list is exhausted. */
export function nth<T>(entries: (T | null)[] | undefined, index: number): T | null {
  if (!entries || entries.length === 0) return null;
  return entries[Math.min(index, entries.length - 1)] ?? null;
}

/**
 * The client the last {@link stubChrome} built — shared by the panel and the pipeline, and wrapped
 * in `withSessionRecovery` like the real one.
 */
let currentClient: BackendClient | null = null;

/**
 * The raw fake under {@link panelClient}, before `withSessionRecovery` — for asserting call counts
 * (the wrapper's methods aren't the `vi.fn`s).
 */
let currentRawClient: BackendClient | null = null;

/** The `BackendClient` for the case being run. Call {@link stubChrome} first. */
export function panelClient(): BackendClient {
  if (!currentClient) throw new Error('stubChrome() must run before panelClient()');
  return currentClient;
}

/** The undecorated fake behind {@link panelClient} — see its own doc comment. */
export function panelRawClient(): BackendClient {
  if (!currentRawClient) throw new Error('stubChrome() must run before panelRawClient()');
  return currentRawClient;
}

/**
 * Stubs `chrome.tabs`, `chrome.runtime.sendMessage` and `chrome.storage.session`, and builds the
 * fake `BackendClient` the panel and pipeline share.
 *
 * Messages go to the **real** listener, router and pipeline against the real `lib/tabStore/`, with
 * only `PipelineDeps` faked — so tests cover message → router → pipeline → store → `onChanged` →
 * `usePipelineRun` → render.
 */
export async function stubChrome(options: StubOptions) {
  let profileCallIndex = 0;
  let analysisCallIndex = 0;
  let fillCallIndex = 0;
  let dispatchCallIndex = 0;
  // Created up front, not when the Fill Step reaches it: a test clicks and then releases within the
  // same tick, long before the pipeline's async path gets as far as `fillPage`.
  let releaseFill!: () => void;
  const fillGate = new Promise<void>((resolve) => {
    releaseFill = resolve;
  });

  // One fake for both halves (panel client and pipeline backend), wrapped in `withSessionRecovery`
  // as in production — which lets a 401-then-success `profileFailures` stand in for adopting the
  // dashboard session.
  const rawClient: BackendClient = createFakeBackendClient({
    getProfile: vi.fn(() => {
      const failure = nth(options.profileFailures, profileCallIndex++);
      return failure
        ? Promise.reject(typeof failure === 'string' ? new Error(failure) : failure)
        : Promise.resolve(options.profile);
    }),
    answerChat: () => Promise.resolve(options.chatReply ?? { reply: 'Here you go.' }),
    ...(options.renderResumePdf ? { renderResumePdf: options.renderResumePdf } : {}),
    extractJob: () => Promise.resolve(jobInfo),
    analyzeApplication: () => {
      const failure = nth(options.analysisFailures, analysisCallIndex++);
      return failure
        ? Promise.reject(typeof failure === 'string' ? new Error(failure) : failure)
        : Promise.resolve({ jobInfo, tailoredResume, answers });
    },
    saveApplication: () => {
      const failure = nth(options.saveFailures, fillCallIndex++);
      return failure
        ? Promise.reject(typeof failure === 'string' ? new Error(failure) : failure)
        : Promise.resolve({ id: 'application-1' });
    },
    findApplicationDuplicates: () => {
      const existing = options.existingApplications ?? [];
      const latest = existing[0];
      return Promise.resolve({
        count: existing.length,
        latest: latest ?? null,
      });
    },
  });
  currentRawClient = rawClient;
  const client: BackendClient = withSessionRecovery(rawClient);
  currentClient = client;

  const deps: PipelineDeps = {
    backend: client,
    page: {
      fill: (_tabId, command) => {
        const result = options.pageDoesNotAnswer
          ? null
          : options.pageKeepsNothing
            ? { ok: true as const, filledFieldIds: [], resumeAttached: false }
            : {
                ok: true as const,
                filledFieldIds: Object.keys(command.values),
                resumeAttached: command.resume !== undefined,
              };
        return options.holdFill ? fillGate.then(() => result) : Promise.resolve(result);
      },
      // The panel's concern is what the Fill Step reports back, not where its fields came from, so
      // these tests leave the live page unreachable and let it fall back to the run's own
      // detection.
      scan: () => Promise.resolve(null),
    },
    // The real detection adapter over the fake session storage — fills fall back to the run's
    // stored snapshot, which must come from the same store analysis checkpointed into.
    detection: productionDetection,
  };

  // The service worker's real listener and router, so START_* messages run the real pipeline and
  // reply as in production.
  const listener = typedMessageListener(
    (message, sender) => handleTypedMessage(message, sender, deps),
    Promise.resolve(),
  );
  const chrome = fakeChrome({
    tab: { id: options.tabId ?? 1, url: options.tabUrl },
    storage: options.sessionStorage,
    sendMessage: (message, callback) => {
      const parsed = TypedMessageEnvelopeSchema.safeParse(message);
      if (!parsed.success) throw new Error('Panel sent an invalid typed-message envelope');
      const typedMessage = parsed.data.payload;
      const isStart = typedMessage.type.startsWith('START_');
      const dispatchFailure = isStart ? nth(options.dispatchFailures, dispatchCallIndex++) : null;
      if (dispatchFailure) {
        Object.defineProperty(globalThis.chrome.runtime, 'lastError', {
          value: { message: dispatchFailure },
          configurable: true,
        });
        callback(undefined);
        Object.defineProperty(globalThis.chrome.runtime, 'lastError', {
          value: undefined,
          configurable: true,
        });
        return;
      }
      // The panel sends no `tab`; only `REPORT_JOB_PAGE` reads one.
      listener(message, {}, callback);
    },
  });

  // Seed detection through the store's own entry point, awaited (the panel reads it on mount).
  if (options.jobPageData) {
    await reportDetectedPage(options.tabId ?? 1, 0, options.jobPageData);
  }

  return {
    openOptionsPage: chrome.openOptionsPage,
    sendMessage: chrome.sendMessage,
    /** Switches the active tab, and navigates one — see `lib/fakeChrome.ts`. */
    activate: chrome.activate,
    navigate: chrome.navigate,
    knowTab: chrome.knowTab,
    sessionStorage: chrome.storage,
    resolveFill: releaseFill,
    setCookie: chrome.setCookie,
  };
}

/**
 * Pastes a job description and clicks "Analyze" (the button is disabled until there's a
 * description).
 */
export async function clickAnalyze(jobDescription = JOB_DESCRIPTION) {
  const textarea = await screen.findByPlaceholderText(/paste the job description/i);
  fireEvent.change(textarea, { target: { value: jobDescription } });
  fireEvent.click(await screen.findByRole('button', { name: 'Analyze' }));
}

/**
 * Filters `sendMessage` mock calls down to a given `TypedMessage` type, e.g. `'START_ANALYSIS'`.
 */
export function callsOfType(sendMessage: ReturnType<typeof vi.fn>, type: string) {
  return sendMessage.mock.calls.flatMap(([message, ...rest]) => {
    const parsed = TypedMessageEnvelopeSchema.safeParse(message);
    return parsed.success && parsed.data.payload.type === type
      ? [[parsed.data.payload, ...rest]]
      : [];
  });
}

export function deferred<T>() {
  return Promise.withResolvers<T>();
}

/**
 * Per-test reset. Stubs `URL.createObjectURL`/`revokeObjectURL` (missing in jsdom) for the resume
 * preview paths.
 */
export function resetPanelTestEnv(): void {
  vi.unstubAllGlobals();
  currentClient = null;
  currentRawClient = null;
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:resume-preview'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
}
