/**
 * What `AutofillTab` shows about a run's questions — which answers may go to the Ask Tab, and which
 * required questions Fill is predicted to leave blank. Pulled out of the component because it is a
 * pure derivation from the run and the page's live detection, with nothing about rendering in it;
 * the surrounding component's own interface is wide enough already without this folded into it.
 */
import type { DetectedField } from '@djobi/shared';
import { autofillSource } from '../lib/fieldDisposition';
import type { JobPageData } from '../lib/messages';
import { answersFor, type FillOutcome, type PipelineRunState } from '../lib/run';

export interface QuestionPresentation {
  /**
   * Which answers may be handed to the Ask Tab: the freeform ones. A `question`-category Detected
   * Field rendered as a select, combobox or radiogroup answers from the page's own fixed options,
   * and rewriting one as prose produces something that can't be filled back in.
   */
  refinableFieldIds: Set<string>;
  /**
   * Which questions Fill will leave blank — decided by `lib/run/answers.ts`'s `answersFor`, the
   * same resolution Fill itself uses, given the same run. Two derivations of this rule is how the
   * panel came to warn about the wrong questions once: it resolved by label set, so it flagged a
   * remounted field whose id Fill still matched, and said nothing about a question whose drafted
   * answer had been dropped.
   *
   * Both sources of fields are folded in: a just-finished Fill scan may have checkpointed new
   * questions onto the run while the panel's own live detection still holds an older, emptier
   * snapshot from the route transition. They overlap, and `unanswered` names each question once.
   */
  unfilledQuestions: DetectedField[];
  /** `unfilledQuestions`, narrowed to the ones that actually block a submission. */
  unfilledRequiredQuestions: DetectedField[];
  /**
   * Whether to show the "won't be filled" banner at all — only until Fill reports. This banner
   * predicts what Fill will skip; once `outcome` is set, `unresolvedRequiredFields` is the page's
   * own account of what it actually kept, and names the same questions plus any the form rejected
   * outright. Showing both listed the same questions twice, under two headings, one of them stale.
   */
  hasNewApplicationQuestions: boolean;
}

export function questionPresentation(
  run: PipelineRunState | null,
  detectedPage: JobPageData | null,
  outcome: FillOutcome | null,
): QuestionPresentation {
  // The run's snapshot wins once analysis has started; before that, the live detection does — the
  // same rule `AutofillTab`'s own `jobPageData` follows for rendering.
  const jobPageData = run?.jobPageData ?? detectedPage;

  const refinableFieldIds = new Set(
    (jobPageData?.fields ?? [])
      .filter(
        (field) =>
          autofillSource(field.category) === 'question' &&
          field.elementRole === 'native' &&
          !field.options,
      )
      .map((field) => field.id),
  );

  const unfilledQuestions = answersFor(run).unanswered([
    ...(run?.jobPageData.fields ?? []),
    ...(detectedPage?.fields ?? []),
  ]);
  const unfilledRequiredQuestions = unfilledQuestions.filter((field) => field.required);
  const hasNewApplicationQuestions = outcome === null && unfilledQuestions.length > 0;

  return {
    refinableFieldIds,
    unfilledQuestions,
    unfilledRequiredQuestions,
    hasNewApplicationQuestions,
  };
}
