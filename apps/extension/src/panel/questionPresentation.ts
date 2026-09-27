/**
 * What `AutofillTab` shows about a run's questions: which answers may go to the Ask Tab, and which
 * required questions Fill will leave blank. A pure derivation from the run and live detection.
 */
import type { DetectedField } from '@djobi/shared';
import { autofillSource } from '../lib/fieldDisposition';
import type { JobPageData } from '../lib/messages';
import { answersFor, type FillOutcome, type PipelineRunState } from '../lib/run';

export interface QuestionPresentation {
  /**
   * Answers that may go to the Ask Tab: freeform only. Choice questions answer from fixed options,
   * so prose can't be filled back.
   */
  refinableFieldIds: Set<string>;
  /**
   * Questions Fill will leave blank, via `lib/run/answers.ts`'s `answersFor` — the same resolution
   * Fill uses. Folds in both the run's fields and live detection (either may be newer); each
   * question is named once.
   */
  unfilledQuestions: DetectedField[];
  /** `unfilledQuestions`, narrowed to the ones that actually block a submission. */
  unfilledRequiredQuestions: DetectedField[];
  /**
   * Whether to show the "won't be filled" prediction — only until Fill reports, after which
   * `unresolvedRequiredFields` is the page's actual account.
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
