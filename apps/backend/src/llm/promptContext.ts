/**
 * The grounding block every writing prompt opens with: the Profile the model may draw on, and the
 * job it is writing toward.
 *
 * `tailorResume.ts` and `answerQuestions.ts` each hand-built these two tags, and the tags are not
 * decoration — the non-fabrication rule in each prompt is written as "not present in the base
 * profile", so it means what `<base_profile>` contains. Three call sites spelling that container
 * out independently is three chances for one of them to name the section something the rule doesn't
 * refer to. This is the one place the container is named.
 *
 * `jobInfo` is optional because the Ask tab can be used with no job page at all — the section is
 * then omitted entirely rather than emitted holding `undefined`, which would read to the model as a
 * job whose every field is unknown.
 */
import type { JobInfo } from '@djobi/shared';

/**
 * The `<base_profile>` (and, when there is one, `<job_info>`) block, without surrounding blank
 * lines — callers place it in their own prompt.
 *
 * @param profile - The Profile projection this operation is grounded in. Only what a caller passes
 *   is shown to the model, so each operation keeps its own projection rather than sharing one.
 * @param jobInfo - The job being written toward, when one is known.
 */
export function groundingContext(profile: object, jobInfo?: JobInfo): string {
  const profileSection = `<base_profile>\n${JSON.stringify(profile)}\n</base_profile>`;
  if (!jobInfo) return profileSection;
  return `${profileSection}\n\n<job_info>\n${JSON.stringify(jobInfo)}\n</job_info>`;
}
