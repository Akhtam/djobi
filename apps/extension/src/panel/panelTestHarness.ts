/**
 * The panel's test harness: one fake Chrome, one set of fixtures, shared by the shell's tests and
 * the Autofill Tab's.
 *
 * It lived inside `App.test.tsx` while that module tested every flow. Splitting the Autofill Tab
 * out of the shell split its tests too, and both halves need the same fake — so the fake moved here
 * rather than being written twice.
 *
 * Not a test module itself (no `.test.` in the name, so vitest doesn't collect it) and imported by
 * nothing the extension ships, so it is dropped from the build.
 */
import type {
  ApplicationStage,
  DetectedField,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { type PipelineDeps } from '../background/applicationPipeline';
import { handleTypedMessage } from '../background/router';
import { createFakeBackendClient, type BackendClient } from '../lib/backendClient';
import { fakeChrome } from '../lib/fakeChrome';
import { type FakeSessionStorage } from '../lib/fakeSessionStorage';
import type { TypedMessage } from '../lib/messages';
import { getPipelineRun, reportDetectedPage, storageKey } from '../lib/tabStore';

export const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

export const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Engineer',
  seniority: 'Senior',
  location: null,
  requirements: [],
  keywords: [],
};

export const tailoredResume: TailoredResume = {
  skills: [],
  workExperience: [],
};

export const questionField: DetectedField = {
  id: 'f-why',
  label: 'Why do you want to work here?',
  inputType: 'textarea',
  selector: '#why-field',
  category: 'question',
  required: false,
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
  profileFailures?: (string | null)[];
  jobPageData?: { fields: DetectedField[] } | null;
  /** Share one `chrome.storage.session` across multiple `stubChrome`/`render` calls — simulates
   *  the panel closing and reopening (unmount + fresh `render`), both of which see the same
   *  underlying session storage in real Chrome. */
  sessionStorage?: FakeSessionStorage;
  /** Message to fail successive Analysis Steps with, `null` for success. The last entry repeats. */
  analysisFailures?: (string | null)[];
  /** Same idea for the explicit Save Application action. */
  saveFailures?: (string | null)[];
  /** Applications already saved for the tab's URL — what the duplicate guard on Analyze finds. */
  existingApplications?: {
    id: string;
    company: string;
    roleTitle: string;
    stage: ApplicationStage;
    createdAt: string;
  }[];
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
export function nth(entries: (string | null)[] | undefined, index: number): string | null {
  if (!entries || entries.length === 0) return null;
  return entries[Math.min(index, entries.length - 1)];
}

/**
 * The client the last {@link stubChrome} built. The panel's modules take a `BackendClient` as a
 * prop, so a test hands them this one — the same adapter the Application Pipeline is given below,
 * so one fake answers both halves of a round trip.
 */
let currentClient: BackendClient | null = null;

/** The `BackendClient` for the case being run. Call {@link stubChrome} first. */
export function panelClient(): BackendClient {
  if (!currentClient) throw new Error('stubChrome() must run before panelClient()');
  return currentClient;
}

/**
 * Stubs `chrome.tabs.query` (active tab), `chrome.runtime.sendMessage` and
 * `chrome.storage.session`, and builds the fake `BackendClient` the panel and the pipeline share.
 *
 * Every `TypedMessage` goes to the **real** `background/router.ts`, which runs the real
 * `background/applicationPipeline.ts` against the real `lib/tabStore.ts`, with only its
 * `PipelineDeps` stubbed — so these tests cover the whole round trip the panel actually depends on:
 * message -> router -> pipeline -> store -> `chrome.storage.onChanged` -> `usePipelineRun` ->
 * render. This stub used to re-implement the pipeline instead, listing by hand every field the
 * runner checkpoints; a change to what the real one wrote left these tests passing regardless. It
 * then re-implemented the *router* for the same reason — the deps seam sat below the dispatch — so
 * a message the real router handled differently, or stopped handling, still passed here. Both
 * re-implementations are gone: the harness sends what the panel sends.
 */
export async function stubChrome(options: StubOptions) {
  let profileCallIndex = 0;
  let analysisCallIndex = 0;
  let fillCallIndex = 0;
  // Created up front, not when the Fill Step reaches it: a test clicks and then releases within the
  // same tick, long before the pipeline's async path gets as far as `fillPage`.
  let releaseFill!: () => void;
  const fillGate = new Promise<void>((resolve) => {
    releaseFill = resolve;
  });

  // One adapter, both halves: the panel's modules are handed this client, and it is also the
  // pipeline's `backend`. They used to be two fakes — the UI's transport mock and the pipeline's
  // dependency — which could disagree about the same route without either test noticing.
  const client: BackendClient = createFakeBackendClient({
    getProfile: vi.fn(() => {
      const failure = nth(options.profileFailures, profileCallIndex++);
      return failure ? Promise.reject(new Error(failure)) : Promise.resolve(options.profile);
    }),
    answerChat: () => Promise.resolve(options.chatReply ?? { reply: 'Here you go.' }),
    ...(options.renderResumePdf ? { renderResumePdf: options.renderResumePdf } : {}),
    extractJob: () => {
      const failure = nth(options.analysisFailures, analysisCallIndex++);
      return failure ? Promise.reject(new Error(failure)) : Promise.resolve(jobInfo);
    },
    tailorResume: () => Promise.resolve(tailoredResume),
    answerQuestions: () => Promise.resolve(answers),
    saveApplication: () => {
      const failure = nth(options.saveFailures, fillCallIndex++);
      return failure
        ? Promise.reject(new Error(failure))
        : Promise.resolve({ id: 'application-1' });
    },
    findApplicationDuplicates: () => {
      const existing = options.existingApplications ?? [];
      const latest = existing[0];
      return Promise.resolve({
        count: existing.length,
        latest: latest
          ? {
              id: latest.id,
              company: latest.company,
              roleTitle: latest.roleTitle,
              stage: latest.stage,
              createdAt: latest.createdAt,
            }
          : null,
      });
    },
  });
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
      // these tests leave the live page unreachable and let it fall back to the run's own detection.
      scan: () => Promise.resolve(null),
    },
  };

  // One fake Chrome, driven through `lib/fakeChrome.ts`. What is specific to the panel is only the
  // message handler below: `START_ANALYSIS`/`START_FILL` run the real pipeline against the real
  // store, which is what makes these cases cover the round trip rather than a re-implementation of
  // it.
  const chrome = fakeChrome({
    tab: { id: options.tabId ?? 1, url: options.tabUrl },
    storage: options.sessionStorage,
    sendMessage: (message, callback) => {
      // The service worker's listener, minus Chrome: one dispatch, fire-and-forget, no reply. The
      // panel is the sender, so it carries no `tab` — only `REPORT_JOB_PAGE` reads one, and the
      // panel never sends that.
      handleTypedMessage(message as unknown as TypedMessage, {}, deps);
      callback(undefined);
    },
  });

  // Both the panel and the Analysis Step read the content script's detection out of the store, so
  // seed it through the store's own entry point rather than writing its layout by hand here.
  // Awaited: the panel reads detection on mount, and an unawaited seed loses that race.
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
  };
}

/**
 * Pastes a job description and clicks "Analyze".
 *
 * Pasting is part of the action now: nothing is scraped from the page, so the button stays disabled
 * until the candidate supplies the posting themselves.
 */
export async function clickAnalyze(jobDescription = JOB_DESCRIPTION) {
  const textarea = await screen.findByPlaceholderText(/paste the job description/i);
  fireEvent.change(textarea, { target: { value: jobDescription } });
  fireEvent.click(await screen.findByRole('button', { name: 'Analyze' }));
}

/** Filters `sendMessage` mock calls down to a given `TypedMessage` type, e.g. `'START_ANALYSIS'`. */
export function callsOfType(sendMessage: ReturnType<typeof vi.fn>, type: string) {
  return sendMessage.mock.calls.filter(([message]) => message?.type === type);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * The per-test reset both modules run. jsdom implements neither `URL.createObjectURL` nor
 * `revokeObjectURL`, so the resume-preview paths get deterministic stubs here — an unmount (which
 * revokes any created URL) and a preview click then behave as they do in Chrome.
 */
export function resetPanelTestEnv(): void {
  vi.unstubAllGlobals();
  currentClient = null;
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:resume-preview'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
}
