/**
 * The Autofill Tab's three pipeline commands, each bound to the optimistic status it raises and the
 * failure that stands it down. A plain factory: attempt state lives in `panel/usePipelineRun.ts`.
 *
 * Checks here are only whether a command can be addressed (a tab, a run, an analysis URL); whether
 * a button is *eligible*, the preview lifecycle, and Run Notice copy stay in the tab.
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
      // Waits for the claim: undelivered or refused (another panel, stale run) both stand the
      // optimistic status down, since neither checkpoints anything to observe.
      void startFill({ type: 'START_FILL', tabId, profile, expectedRunId: run.runId }).then(
        (outcome) => {
          if (!outcome.claimed) undelivered();
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
        if (!outcome.claimed) undelivered();
      });
    },
  };
}
