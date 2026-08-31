import {
  TailorResumeProfileSchema,
  type JobInfo,
  type TailorResumeProfile,
  type TailoredResume,
} from '@djobi/shared';
import { z } from 'zod';
import { groundingContext, jobContext } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/** Compact model output: source indices replace work-experience metadata the backend already owns. */
const TailoredResumeOutputSchema = z.object({
  workExperience: z.array(
    z.object({
      sourceIndex: z.number().int(),
      bullets: z.array(
        z.object({
          sourceIndex: z.number().int(),
          text: z.string().optional(),
        }),
      ),
    }),
  ),
});

type ModelResume = z.infer<typeof TailoredResumeOutputSchema>;
type ModelRole = ModelResume['workExperience'][number];

function effectiveCap(
  profile: TailorResumeProfile,
  role: TailorResumeProfile['workExperience'][number],
): number {
  return Math.max(role.maxBullets ?? profile.maxBulletsPerRole, role.starredIndices.length);
}

/** Bounds the compact resume object by selected output, not by the unbounded source bank. */
function outputTokenLimit(profile: TailorResumeProfile): number {
  const estimate = profile.workExperience.reduce((sum, role) => {
    const selected = Math.min(role.bullets.length, effectiveCap(profile, role));
    const starred = role.starredIndices.length;
    return sum + 24 + starred * 16 + Math.max(0, selected - starred) * 56;
  }, 0);
  return Math.min(2048, Math.max(512, estimate));
}

/** Safe authored-order selection when model pointers for a role are malformed or absent. */
function fallbackBullets(
  profile: TailorResumeProfile,
  role: TailorResumeProfile['workExperience'][number],
): string[] {
  const starred = new Set(role.starredIndices);
  let discretionary = effectiveCap(profile, role) - starred.size;
  return role.bullets.filter((_, index) => {
    if (starred.has(index)) return true;
    if (discretionary === 0) return false;
    discretionary -= 1;
    return true;
  });
}

/** Resolves selected/reworded bullets against one authoritative Profile role. */
function bulletsFor(
  profile: TailorResumeProfile,
  role: TailorResumeProfile['workExperience'][number],
  modelRole: ModelRole,
) {
  const counts = new Map<number, number>();
  for (const bullet of modelRole.bullets) {
    counts.set(bullet.sourceIndex, (counts.get(bullet.sourceIndex) ?? 0) + 1);
  }
  const starred = new Set(role.starredIndices);
  if (role.starredIndices.some((index) => counts.get(index) !== 1)) {
    return fallbackBullets(profile, role);
  }

  const resolved = modelRole.bullets.flatMap((bullet) => {
    if (counts.get(bullet.sourceIndex) !== 1 || role.bullets[bullet.sourceIndex] === undefined) {
      return [];
    }
    if (starred.has(bullet.sourceIndex)) {
      return [{ text: role.bullets[bullet.sourceIndex], starred: true }];
    }
    const text = bullet.text?.trim();
    return text ? [{ text, starred: false }] : [];
  });

  // Invalid pointers are a malformed tailoring result, not an instruction to erase a real role.
  if (modelRole.bullets.length > 0 && resolved.length === 0) {
    return fallbackBullets(profile, role);
  }

  let discretionary = effectiveCap(profile, role) - starred.size;
  return resolved.flatMap((bullet) => {
    if (bullet.starred) return [bullet.text];
    if (discretionary === 0) return [];
    discretionary -= 1;
    return [bullet.text];
  });
}

/** Rejoins compact, untrusted model output to authoritative Profile fields. */
function reconcileResume(profile: TailorResumeProfile, modelResume: ModelResume): TailoredResume {
  const roleCounts = new Map<number, number>();
  for (const role of modelResume.workExperience) {
    roleCounts.set(role.sourceIndex, (roleCounts.get(role.sourceIndex) ?? 0) + 1);
  }
  const safeModelRoles = modelResume.workExperience.filter(
    (role) =>
      profile.workExperience[role.sourceIndex] !== undefined &&
      roleCounts.get(role.sourceIndex) === 1,
  );
  const safelyReordered =
    safeModelRoles.length === profile.workExperience.length &&
    profile.workExperience.every((_, index) => roleCounts.get(index) === 1);

  const roleByIndex = new Map(safeModelRoles.map((role) => [role.sourceIndex, role] as const));
  const orderedIndices = safelyReordered
    ? safeModelRoles.map((role) => role.sourceIndex)
    : profile.workExperience.map((_, index) => index);
  const workExperience = orderedIndices.map((index) => {
    const role = profile.workExperience[index];
    const modelRole = roleByIndex.get(index);
    const { company, title, startDate, endDate } = role;
    return {
      company,
      title,
      startDate,
      endDate,
      bullets: modelRole ? bulletsFor(profile, role, modelRole) : fallbackBullets(profile, role),
    };
  });

  return { skills: profile.skills, workExperience };
}

/** Tailors a resume using compact source pointers and server-side reconstruction. */
export async function tailorResume(
  profile: TailorResumeProfile,
  jobInfo: JobInfo,
  signal?: AbortSignal,
): Promise<TailoredResume> {
  if (profile.workExperience.length === 0) {
    return { skills: profile.skills, workExperience: [] };
  }

  // Applied, not restated. The route parses the same schema on the way in, so this is redundant for
  // an HTTP caller — and load-bearing for every other one: a full `Profile` is structurally
  // assignable to `TailorResumeProfile`, so a direct caller passing one put the candidate's phone,
  // location and screening declarations into the prompt with nothing to notice. The projection is
  // enforced where the grounding is built, by the schema that states it.
  const grounding = TailorResumeProfileSchema.parse(profile);
  const instructions = `Tailor the candidate's resume to this job. Reorder and concisely reword existing non-starred bullets to emphasize job_info requirements and keywords, using natural language that does not sound robotic. Never invent experience, skills, or achievements. A role's maxBullets overrides maxBulletsPerRole; both are maximums, never targets, so do not pad a role with weak or fabricated content.

The arrays in base_profile are authoritative and zero-indexed. Skills are copied unchanged by the server and must not appear in the output. Return every work-experience role exactly once as {"sourceIndex":N,"bullets":[...]}; sourceIndex points into base_profile.workExperience and controls role order. Bullets may be reordered or omitted up to the role's cap. Every index in starredIndices is already selected: return each exactly once as {"sourceIndex":M} with no text, and exclude it from the bullets you select. For each selected non-starred bullet return {"sourceIndex":M,"text":"..."}, where sourceIndex points into that role's original bullets and text is its truth-preserving rewrite. Do not copy company, title, dates, or skill text into the output.

${groundingContext(grounding)}`;

  const modelResume = await callStructured({
    signal,
    operation: 'tailorResume',
    maxTokens: outputTokenLimit(grounding),
    toolName: 'report_tailored_resume',
    toolDescription: 'Report the resume content tailored to this specific job.',
    schema: TailoredResumeOutputSchema,
    cachedPrefix: instructions,
    userContent: jobContext(jobInfo),
  });

  return reconcileResume(grounding, modelResume);
}
