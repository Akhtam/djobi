import {
  baseResumeOf,
  requirementEvidence,
  TailorResumeProfileSchema,
  type JobInfo,
  type TailorResumeProfile,
  type TailoredResume,
} from '@djobi/shared';
import { z } from 'zod';
import { verifyBulletRewrite } from './bulletTruthfulness.js';
import { groundingContext, jobContext, sanitizeXmlContent } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/**
 * Integer index, checked locally. Not `.int()`: zod 4 emits safe-integer bounds some routes don't
 * support; `.meta` gives plain `"type": "integer"`. Range is checked at lookup.
 */
const SourceIndexSchema = z
  .number()
  .refine(Number.isInteger, 'sourceIndex must be an integer')
  .meta({ type: 'integer' });

/**
 * Compact model output: source indices replace work-experience metadata the backend already owns.
 */
const TailoredResumeOutputSchema = z.object({
  workExperience: z.array(
    z.object({
      sourceIndex: SourceIndexSchema,
      bullets: z.array(
        z.object({
          sourceIndex: SourceIndexSchema,
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
    const sourceText = role.bullets[bullet.sourceIndex];
    if (counts.get(bullet.sourceIndex) !== 1 || sourceText === undefined) {
      return [];
    }
    if (starred.has(bullet.sourceIndex)) {
      return [{ text: sourceText, starred: true }];
    }
    const text = bullet.text?.trim();
    // A rewrite adding numbers or named specifics the source lacks reverts to the source verbatim
    // (see bulletTruthfulness.ts).
    return text ? [{ text: verifyBulletRewrite(text, sourceText), starred: false }] : [];
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

/**
 * Rejoins compact, untrusted model output to authoritative Profile fields. Role order always
 * follows the Profile; only bullets within a role are selected and reordered. Bad `sourceIndex`
 * pointers fall back to the role's authored bullets rather than dropping the role.
 */
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
  const roleByIndex = new Map(safeModelRoles.map((role) => [role.sourceIndex, role] as const));

  const workExperience = profile.workExperience
    .map((role, index) => {
      const modelRole = roleByIndex.get(index);
      const { company, title, startDate, endDate } = role;
      return {
        company,
        title,
        startDate,
        endDate,
        bullets: modelRole ? bulletsFor(profile, role, modelRole) : fallbackBullets(profile, role),
      };
    })
    // An explicit, candidate-set opt-in only — see WorkExperienceSchema.suppressIfEmpty. Silently
    // hiding a role nobody asked to hide would misrepresent the candidate's own employment history.
    .filter(
      (role, index) => role.bullets.length > 0 || !profile.workExperience[index]?.suppressIfEmpty,
    );

  return { skills: profile.skills, workExperience };
}

/**
 * What the Profile's full, uncapped bullet bank evidences for each requirement, most decisive
 * first, so the model spends its selection budget where the Profile can support it. Computed
 * before the model call against `baseResumeOf(grounding)`. `''` when there are no requirements.
 */
function requirementEvidenceContext(grounding: TailorResumeProfile, jobInfo: JobInfo): string {
  const evidence = requirementEvidence(baseResumeOf(grounding), jobInfo, grounding);
  if (evidence.length === 0) return '';

  const summary = evidence.map(({ requirement, verdict, evidence: match }) => ({
    requirement: requirement.text,
    kind: requirement.kind,
    // Shown so the model knows why the list is ordered this way; `null` on older extractions.
    importance: requirement.importance,
    verdict,
    evidencedBy: match,
  }));
  return `\n\n<requirement_evidence>\n${sanitizeXmlContent(JSON.stringify(summary))}\n</requirement_evidence>`;
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

  // Enforce the projection here: a direct caller passing a full `Profile` would otherwise leak
  // phone, location and screening answers into the prompt.
  const grounding = TailorResumeProfileSchema.parse(profile);
  const instructions = `Tailor the candidate's resume to this job. Reorder and concisely reword existing non-starred bullets to emphasize job_info requirements and keywords, using natural language that does not sound robotic. Never invent experience, skills, or achievements. A role's maxBullets overrides maxBulletsPerRole; both are maximums, never targets, so do not pad a role with weak or fabricated content.

The arrays in base_profile are authoritative and zero-indexed. Skills are copied unchanged by the server and must not appear in the output. Return every work-experience role exactly once as {"sourceIndex":N,"bullets":[...]}; sourceIndex selects which role's bullets you are reporting, not where that role appears — role order always follows base_profile's own reverse-chronological order and cannot be changed. Bullets may be reordered or omitted up to the role's cap. Every index in starredIndices is already selected: return each exactly once as {"sourceIndex":M} with no text, and exclude it from the bullets you select. For each selected non-starred bullet return {"sourceIndex":M,"text":"..."}, where sourceIndex points into that role's original bullets and text is its truth-preserving rewrite. Do not copy company, title, dates, or skill text into the output.

A requirement_evidence block, when present, is a deterministic pre-check of what base_profile's bullets already evidence per requirement. It is ordered by how much each requirement decides this application — most decisive first, and within one importance the unmet before the met — so earlier entries matter more than later ones. Prioritize keeping or selecting the bullets it names as evidencedBy for direct-evidence/skill-only/omitted-profile-evidence entries near the top of that list over bullets that only serve entries near the bottom. It also names unsupported/needs-confirmation entries so you can leave them alone rather than spend a rewrite pretending to address them — never invent a bullet or a detail to cover one.

${groundingContext(grounding)}`;

  const modelResume = await callStructured({
    signal,
    operation: 'tailorResume',
    maxTokens: outputTokenLimit(grounding),
    toolName: 'report_tailored_resume',
    toolDescription: 'Report the resume content tailored to this specific job.',
    schema: TailoredResumeOutputSchema,
    cachedPrefix: instructions,
    userContent: jobContext(jobInfo) + requirementEvidenceContext(grounding, jobInfo),
  });

  return reconcileResume(grounding, modelResume);
}
