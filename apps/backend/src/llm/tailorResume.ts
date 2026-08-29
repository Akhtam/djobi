import { type JobInfo, type TailorResumeProfile, type TailoredResume } from '@djobi/shared';
import { z } from 'zod';
import { MODELS } from './client.js';
import { groundingContext } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/** Compact model output: source indices replace work-experience metadata the backend already owns. */
const TailoredResumeOutputSchema = z.object({
  workExperience: z.array(
    z.object({
      sourceIndex: z.number().int(),
      bullets: z.array(
        z.object({
          sourceIndex: z.number().int(),
          text: z.string(),
        }),
      ),
    }),
  ),
});

type ModelResume = z.infer<typeof TailoredResumeOutputSchema>;
type ModelRole = ModelResume['workExperience'][number];

/** Bounds the compact resume object, scaled by how many source bullets it may contain. */
function outputTokenLimit(profile: TailorResumeProfile): number {
  const bulletCount = profile.workExperience.reduce((sum, role) => sum + role.bullets.length, 0);
  return Math.min(2048, Math.max(512, bulletCount * 120));
}

/** Resolves selected/reworded bullets against one authoritative Profile role. */
function bulletsFor(role: TailorResumeProfile['workExperience'][number], modelRole: ModelRole) {
  const counts = new Map<number, number>();
  for (const bullet of modelRole.bullets) {
    counts.set(bullet.sourceIndex, (counts.get(bullet.sourceIndex) ?? 0) + 1);
  }

  const bullets = modelRole.bullets.flatMap((bullet) => {
    if (
      counts.get(bullet.sourceIndex) !== 1 ||
      role.bullets[bullet.sourceIndex] === undefined ||
      !bullet.text.trim()
    ) {
      return [];
    }
    return [bullet.text.trim()];
  });

  // Invalid pointers are a malformed tailoring result, not an instruction to erase a real role.
  return modelRole.bullets.length > 0 && bullets.length === 0 ? role.bullets : bullets;
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
    return { ...role, bullets: modelRole ? bulletsFor(role, modelRole) : role.bullets };
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

  const relevantProfile = {
    workExperience: profile.workExperience,
    skills: profile.skills,
  };

  const modelResume = await callStructured({
    signal,
    model: MODELS.tailorResume,
    // Adaptive reasoning previously spent 1.3k–2.3k tokens on an object measured at 179–330 tokens,
    // pushing this call past 20 seconds. Selection and truth-preserving rewrites do not warrant it.
    effort: 'none',
    maxTokens: outputTokenLimit(profile),
    toolName: 'report_tailored_resume',
    toolDescription: 'Report the resume content tailored to this specific job.',
    schema: TailoredResumeOutputSchema,
    userContent: `Tailor the candidate's resume to this job. Reorder and reword existing bullets to emphasize relevant requirements and keywords. Never invent experience, skills, or achievements.

The arrays in base_profile are authoritative and zero-indexed. Skills are copied unchanged by the server and must not appear in the output. Return every work-experience role exactly once as {"sourceIndex":N,"bullets":[...]}; sourceIndex points into base_profile.workExperience and controls role order. Each bullet is {"sourceIndex":M,"text":"..."}, where sourceIndex points into that role's original bullets and text is its concise, truth-preserving rewrite. Bullets may be reordered or omitted. Do not copy company, title, dates, or skill text into the output.

${groundingContext(relevantProfile, jobInfo)}`,
  });

  return reconcileResume(profile, modelResume);
}
