/**
 * The grounding block every writing prompt opens with: `<base_profile>` and, when known,
 * `<job_info>`. Named in one place because each prompt's non-fabrication rule refers to what
 * `<base_profile>` contains. Without a job (Ask tab, cold), the section is omitted.
 */
import type { JobInfo } from '@djobi/shared';

/** Escapes closing-tag sequences so injected content can't break out of the scaffold. */
export function sanitizeXmlContent(content: string): string {
  return content.replace(/<\//g, '<\\/');
}

/**
 * The `<base_profile>` (and optional `<job_info>`) block, no surrounding blank lines.
 *
 * @param profile - The operation's own Profile projection; only this is shown to the model.
 */
export function groundingContext(profile: object, jobInfo?: JobInfo): string {
  const profileSection = `<base_profile>\n${sanitizeXmlContent(JSON.stringify(profile))}\n</base_profile>`;
  if (!jobInfo) return profileSection;
  return `${profileSection}\n\n${jobContext(jobInfo)}`;
}

/**
 * The `<job_info>` block alone — for `answerQuestions`, which keeps the Profile in a cached prefix
 * and the job outside it.
 */
export function jobContext(jobInfo: JobInfo): string {
  return `<job_info>\n${sanitizeXmlContent(JSON.stringify(jobInfo))}\n</job_info>`;
}
