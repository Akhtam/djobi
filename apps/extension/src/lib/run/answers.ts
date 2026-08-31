/**
 * Which drafted Question Answer fills which Detected Field, for one Application Pipeline run.
 *
 * `matchAnswerToField` in `@djobi/shared` states the *rule* — id first, then unambiguous question
 * text. What it can't state is where its three arguments come from, and two of them always come
 * from the same run: the drafted answers, and the labels those answers were drafted under, keyed by
 * the field id the Analysis Step saw. Both call sites rebuilt that map by hand from
 * `run.jobPageData.fields`, which is the *analyzed* detection — not the fresh scan the Fill Step
 * takes, and not the panel's own live detection, either of which type-checks here and is wrong.
 * The panel has already had a version of that bug: it resolved by label set instead, so it flagged
 * a remounted field the Fill Step went on to match, and stayed silent about a question whose answer
 * had been dropped.
 *
 * So the run is the argument. The map is built once, inside, from the one source that can be right.
 */
import { matchAnswerToField, normalizeLabel, type DetectedField } from '@djobi/shared';
import { autofillSource } from '../fieldDisposition';
import type { PipelineRunState } from './state';

/** The run's answers, resolved against whatever fields a caller has in hand. */
export interface RunAnswers {
  /** The reviewed answer for `field`, or `undefined` if this run drafted none it can match. */
  valueFor(field: DetectedField): string | undefined;
  /**
   * The `question` fields among `fields` this run has no answer for, named once each.
   *
   * De-duplicated by {@link normalizeLabel} because callers legitimately hold overlapping field
   * lists — the panel merges the run's analyzed detection with its own live scan, so the same
   * question arrives twice and must be reported once.
   */
  unanswered(fields: readonly DetectedField[]): DetectedField[];
}

/** Nothing analyzed: no answers to match, and so no question this run has left unanswered. */
const NONE: RunAnswers = { valueFor: () => undefined, unanswered: () => [] };

/**
 * The answer resolution for `run`.
 *
 * A `null` run resolves nothing *and* reports nothing unanswered — deliberately not symmetric.
 * Before an Analysis Step there are no drafted answers, so every question is unfilled in the
 * trivial sense; saying so would put a warning about unanswered questions on a page the candidate
 * has not analyzed yet.
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
