/**
 * Which drafted Question Answer fills which Detected Field, for one run. `matchAnswerToField`
 * (`@djobi/shared`) is the rule; this builds its inputs from the run itself — the drafted answers
 * and the *analyzed* labels — so callers can't pass the fresh scan or the panel's live detection by
 * mistake.
 */
import { matchAnswerToField, normalizeLabel, type DetectedField } from '@djobi/shared';
import { autofillSource } from '../fieldDisposition';
import type { PipelineRunState } from './state';

/** The run's answers, resolved against whatever fields a caller has in hand. */
export interface RunAnswers {
  /** The reviewed answer for `field`, or `undefined` if this run drafted none it can match. */
  valueFor(field: DetectedField): string | undefined;
  /**
   * The `question` fields among `fields` this run has no answer for, de-duplicated by
   * {@link normalizeLabel} (the panel passes overlapping analyzed and live lists).
   */
  unanswered(fields: readonly DetectedField[]): DetectedField[];
}

/** Nothing analyzed: no answers to match, and so no question this run has left unanswered. */
const NONE: RunAnswers = { valueFor: () => undefined, unanswered: () => [] };

/**
 * The answer resolution for `run`. A `null` run resolves nothing and reports nothing unanswered —
 * before analysis, warning about unanswered questions would be noise.
 */
export function answersFor(
  run: Pick<PipelineRunState, 'jobPageData' | 'answers'> | null,
): RunAnswers {
  if (!run) return NONE;

  const { answers } = run;
  const labelByAnalyzedId = new Map(
    run.jobPageData.fields.map((field) => [field.id, field.label] as const),
  );

  return {
    valueFor: (field) => matchAnswerToField(field, answers, labelByAnalyzedId),

    unanswered(fields) {
      const named = new Set<string>();
      const unanswered: DetectedField[] = [];
      for (const field of fields) {
        if (autofillSource(field.category) !== 'question') continue;
        if (matchAnswerToField(field, answers, labelByAnalyzedId) !== undefined) continue;
        const name = normalizeLabel(field.label);
        if (named.has(name)) continue;
        named.add(name);
        unanswered.push(field);
      }
      return unanswered;
    },
  };
}
