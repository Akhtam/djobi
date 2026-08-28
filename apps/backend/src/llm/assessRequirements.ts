import { type AssessRequirementsProfile, type JobInfo, type RequirementFit } from '@djobi/shared';
import { z } from 'zod';
import { FAST_MODEL } from './client.js';
import { groundingContext } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/** Where in the Profile the evidence for one verdict sits. */
const EvidencePointerSchema = z.union([
  z.object({ kind: z.literal('skill'), index: z.number().int() }),
  z.object({ kind: z.literal('education'), index: z.number().int() }),
  z.object({ kind: z.literal('role'), roleIndex: z.number().int() }),
  z.object({
    kind: z.literal('bullet'),
    roleIndex: z.number().int(),
    bulletIndex: z.number().int(),
  }),
]);

/** One compact model result. The authoritative requirement is attached locally by input index. */
const RequirementAssessmentOutputSchema = z.object({
  verdict: z.enum(['met', 'partial', 'unmet']),
  evidence: EvidencePointerSchema.nullable(),
  note: z.string().default(''),
});

type ModelAssessment = z.infer<typeof RequirementAssessmentOutputSchema>;
type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

/** Four small generations provide most of the fan-out gain without creating an unbounded burst. */
const MAX_CONCURRENT_REQUIREMENTS = 4;

/** The Profile text a pointer names, or `null` if it names nothing that exists. */
function resolveEvidence(
  profile: AssessRequirementsProfile,
  pointer: EvidencePointer | null,
): string | null {
  if (!pointer) return null;
  if (pointer.kind === 'skill') return profile.skills[pointer.index] ?? null;
  if (pointer.kind === 'bullet') {
    return profile.workExperience[pointer.roleIndex]?.bullets[pointer.bulletIndex] ?? null;
  }
  if (pointer.kind === 'education') {
    const education = profile.education[pointer.index];
    if (!education) return null;
    return [
      [education.degree, education.field].filter(Boolean).join(' in '),
      education.school,
      education.graduationYear,
    ]
      .filter(Boolean)
      .join(', ');
  }

  const role = profile.workExperience[pointer.roleIndex];
  if (!role) return null;
  return `${role.title} at ${role.company} (${role.startDate}-${role.endDate ?? 'Present'})`;
}

/** Rejoins one untrusted model result to its authoritative requirement. */
function reconcileAssessment(
  profile: AssessRequirementsProfile,
  requirement: string,
  assessment: ModelAssessment,
): RequirementFit {
  const claimsFit = assessment.verdict === 'met' || assessment.verdict === 'partial';
  const evidence = claimsFit ? resolveEvidence(profile, assessment.evidence) : null;

  if (claimsFit && evidence === null) {
    return { requirement, verdict: 'unmet', evidence: null, note: assessment.note };
  }
  return {
    requirement,
    verdict: assessment.verdict,
    evidence,
    note: assessment.note,
  };
}

/** Runs independent requirement calls in order, aborting active siblings after the first failure. */
async function assessWithConcurrency(
  requirements: readonly string[],
  task: (requirement: string, signal: AbortSignal) => Promise<RequirementFit>,
  externalSignal?: AbortSignal,
): Promise<RequirementFit[]> {
  const controller = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  const results = new Array<RequirementFit>(requirements.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = next++;
      if (index >= requirements.length) return;
      try {
        results[index] = await task(requirements[index], signal);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_REQUIREMENTS, requirements.length) }, worker),
  );
  if (signal.aborted) throw signal.reason;
  return results;
}

/** Judges the Profile against each stated requirement using bounded parallel Haiku calls. */
export async function assessRequirements(
  profile: AssessRequirementsProfile,
  jobInfo: JobInfo,
  signal?: AbortSignal,
): Promise<RequirementFit[]> {
  if (jobInfo.requirements.length === 0) return [];

  return assessWithConcurrency(
    jobInfo.requirements,
    async (requirement, requestSignal) => {
      const assessment = await callStructured({
        signal: requestSignal,
        // Haiku is enough here: every positive claim is resolved back to authoritative Profile data.
        model: FAST_MODEL,
        maxTokens: 512,
        toolName: 'report_requirement_fit',
        toolDescription: "Report how the candidate's profile measures up to one requirement.",
        schema: RequirementAssessmentOutputSchema,
        userContent: `Assess the candidate's base profile against the single requirement in job_info.requirements.

Give a verdict of "met", "partial" or "unmet". A verdict of "met" or "partial" MUST cite the single strongest evidence as an index into base_profile: {"kind":"skill","index":N}, {"kind":"education","index":N}, {"kind":"role","roleIndex":N}, or {"kind":"bullet","roleIndex":N,"bulletIndex":M}. A verdict you cannot point at is "unmet". Set evidence to null for "unmet".

Use note for one short sentence saying what is missing or only partial, addressed to the candidate. Leave it empty for a plain "met".

${groundingContext(profile, { ...jobInfo, requirements: [requirement] })}`,
      });

      return reconcileAssessment(profile, requirement, assessment);
    },
    signal,
  );
}
