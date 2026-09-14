/**
 * The three commands the Autofill Tab sends the Application Pipeline, each bound to the optimistic
 * status it raises and the failure it stands that status down with.
 *
 * The tab used to send them itself, and every one of them restated the same four facts: which
 * status means "this step is running", which message type starts it, which status and step name its
 * failure, and — since `background/runClaim.ts` — which run it is about. Nine loose facts paired
 * only by inspection, in a module whose actual subject is what the candidate sees. Nothing stopped
 * `begin('filling')` standing beside `fail('save-error', …)`.
 *
 * A plain factory rather than a hook: it holds no state of its own, and the one piece of state
 * involved — which attempt is current — belongs to `panel/usePipelineRun.ts`, which already owns
 * the reconciliation the optimistic status is part of.
 *
 * What stays in the tab is what is genuinely the tab's: whether a button is *eligible* to be
 * pressed (the run has an analysis, the status allows it), the resume preview's lifecycle, and
 * every word of Run Notice copy. What is checked here is only whether the command can be addressed
 * at all — Chrome has named a tab, there is a run to name, an analysis URL exists.
 */
import type { Profile } from '@djobi/shared';
import { notify, startFill, startSaveApplication } from '../lib/messages';
import type { RunStep } from '../lib/run';
import type { ActiveRun } from './useActiveRun';
import type { JobDescription } from './useJobDescription';

type CommandName<Step extends RunStep> = Step extends 'analysis' ? 'analyze' : Step;
type CommandFor<Step extends RunStep> = Step extends 'analysis'
  ? (force?: boolean) => boolean
  : () => void;

/** Every run step's panel command. A new step cannot be omitted from the factory below. */
export type PipelineCommands = {
  [Step in RunStep as CommandName<Step>]: CommandFor<Step>;
};

export function pipelineCommands(
  activeRun: ActiveRun,
  profile: Profile,
  jobDescription: JobDescription,
): PipelineCommands {
  const { tabId, run, beginCommand } = activeRun;

  return {
    analyze(force = false) {
      if (tabId === null || !jobDescription.analysisUrl || !jobDescription.text.trim())
        return false;

      const undelivered = beginCommand('analysis');
      notify(
        {
          type: 'START_ANALYSIS',
          tabId,
          tabUrl: jobDescription.analysisUrl,
          profile,
          jobDescription: jobDescription.text,
          force,
        },
        undelivered,
      );
      return true;
    },

    fill() {
      // A run to name, not merely a tab: `expectedRunId` is what stops a command delayed past a
      // re-analysis from filling a different posting's form.
      if (tabId === null || !run) return;

      const undelivered = beginCommand('fill');
      // `startFill` waits for whether the claim was actually won — an undelivered command and a
      // refused one (another panel already running this step, or a stale `expectedRunId`) both
      // stand the optimistic status down the same way, since neither leaves anything checkpointed
      // for `usePipelineRun.ts` to observe.
      void startFill({ type: 'START_FILL', tabId, profile, expectedRunId: run.runId }).then(
        (outcome) => {
          if (!outcome.claimed) undelivered('');
        },
      );
    },

    save() {
      if (tabId === null || !run) return;

      const undelivered = beginCommand('save');
      void startSaveApplication({
        type: 'START_SAVE_APPLICATION',
        tabId,
        expectedRunId: run.runId,
      }).then((outcome) => {
        if (!outcome.claimed) undelivered('');
      });
    },
  };
}
