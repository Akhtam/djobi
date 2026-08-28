import { type AssessRequirementsProfile, type JobInfo, type RequirementFit } from '@djobi/shared';
import { z } from 'zod';
import { MODEL } from './client.js';
import { groundingContext } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/**
 * Where in the Profile the evidence for a verdict sits.
 *
 * **The model returns a pointer, never prose.** Given a sentence back, the backend cannot tell a
 * real assessment from an invented one — the same problem `reconcileResume` solves by keying model
 * entries to profile entries, and the one `PROGRESS.md`'s Phase 10 solves for bullet selection with
 * a `sourceIndex`. An index either resolves against the real Profile or it doesn't, and that is a
 * question code can answer.
 *
 * These indices are a detail of the model call and are resolved away before anything leaves this
 * module: {@link RequirementFit} carries the evidence *text*.
 */
const EvidencePointerSchema = z.union([
  z.object({ kind: z.literal('skill'), index: z.number().int() }),
  z.object({
    kind: z.literal('bullet'),
    roleIndex: z.number().int(),
    bulletIndex: z.number().int(),
  }),
]);

/**
 * Normalizes the shapes the model reaches for when this tool asks it for an array.
 *
 * The tool's `input_schema` does say `"type": "array"` here — this module's tests assert it — but a
 * tool schema is advisory, not enforced, and these four deviations are the ones this call actually
 * produces:
 *
 * - the array double-encoded as a JSON string;
 * - the array re-wrapped in the tool's own `{ fit: … }` envelope;
 * - an index-keyed object, `{"0": …, "1": …}`, instead of an array;
 * - a lone entry sent unwrapped, which is what a posting stating one requirement invites.
 *
 * Each is recoverable by rearranging the container alone, without interpreting a single verdict, and
 * each otherwise costs the candidate a whole Requirement Fit report to a 500. Anything this does not
 * recognize is passed through untouched, so an output that means something else still fails
 * validation rather than being quietly reinterpreted into a report.
 */
function asFitArray(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return asFitArray(JSON.parse(value) as unknown);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value) || typeof value !== 'object' || value === null) return value;

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1 && entries[0][0] === 'fit') return asFitArray(entries[0][1]);
  if (entries.length > 0 && entries.every(([key]) => /^\d+$/.test(key))) {
    return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, entry]) => entry);
  }
  // Keyed on the two fields every entry must have, so a container holding anything else is left to
  // fail validation rather than being wrapped into a one-entry report.
  if ('requirement' in value && 'verdict' in value) return [value];
  return value;
}

const RequirementFitOutputSchema = z.object({
  fit: z.preprocess(
    asFitArray,
    z.array(
      z.object({
        requirement: z.string(),
        verdict: z.enum(['met', 'partial', 'unmet']),
        evidence: EvidencePointerSchema.nullable(),
        // Defaulted rather than required, for the reason `QuestionAnswer.sourceStoryIds` is: the
        // model routinely omits a key whose value is empty, and one omission must not fail the batch.
        note: z.string().default(''),
      }),
    ),
  ),
});

type ModelFit = z.infer<typeof RequirementFitOutputSchema>['fit'][number];
type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

/** The Profile text a pointer names, or `null` if it names nothing that exists. */
function resolveEvidence(
  profile: AssessRequirementsProfile,
  pointer: EvidencePointer | null,
): string | null {
  if (!pointer) return null;
  if (pointer.kind === 'skill') return profile.skills[pointer.index] ?? null;
  return profile.workExperience[pointer.roleIndex]?.bullets[pointer.bulletIndex] ?? null;
}

/**
 * Keeps a verdict only where the Profile bears it out, and reports every stated requirement exactly
 * once in the posting's own order.
 *
 * Three rules, each guarding a different way the raw output can mislead:
 *
 * - **A `met`/`partial` whose pointer doesn't resolve becomes `unmet`.** This is the conservative
 *   direction on purpose: the failure it prevents is telling a candidate they qualify on evidence
 *   that does not exist, which is worse than under-selling them, and it is the same judgement
 *   `matchKnownAnswer` makes when it declines an ambiguous inference.
 * - **A requirement the posting never stated is dropped.** Otherwise the model can answer a question
 *   nobody asked, and the report stops being about this posting.
 * - **A requirement the model skipped is reported `unmet`.** Silence must never read as qualified,
 *   and a report missing rows would quietly shrink the very list the candidate is checking.
 */
function reconcileRequirementFit(
  profile: AssessRequirementsProfile,
  jobInfo: JobInfo,
  modelFit: ModelFit[],
): RequirementFit[] {
  const byRequirement = new Map<string, ModelFit>();
  for (const entry of modelFit) {
    if (!byRequirement.has(entry.requirement)) byRequirement.set(entry.requirement, entry);
  }

  return jobInfo.requirements.map((requirement) => {
    const entry = byRequirement.get(requirement);
    const evidence = entry ? resolveEvidence(profile, entry.evidence) : null;
    const claimsFit = entry?.verdict === 'met' || entry?.verdict === 'partial';

    if (!entry || (claimsFit && evidence === null)) {
      return { requirement, verdict: 'unmet' as const, evidence: null, note: entry?.note ?? '' };
    }

    return {
      requirement,
      verdict: entry.verdict,
      // Only a verdict that claims fit carries evidence; an `unmet` one has nothing to point at.
      evidence: claimsFit ? evidence : null,
      note: entry.note,
    };
  });
}

/**
 * Judges the Profile against each of a posting's stated requirements.
 *
 * Assessed against the **Profile**, not the Tailored Resume: the question is whether the candidate
 * has the thing, not whether one particular render mentions it. A resume that omitted a real
 * qualification is a tailoring problem, and reporting it as a gap would send the candidate to fix
 * something that isn't broken.
 *
 * @param profile - The candidate's Profile, projected to what a qualification judgement needs.
 * @param jobInfo - The job whose `requirements` are being assessed.
 * @returns One entry per stated requirement, in the posting's order, each already reconciled.
 * @throws If the model doesn't return a tool call, or returns one that fails validation.
 */
export async function assessRequirements(
  profile: AssessRequirementsProfile,
  jobInfo: JobInfo,
): Promise<RequirementFit[]> {
  // No requirements is not a model call. Mirrors `answerQuestions` returning `[]` for no questions.
  if (jobInfo.requirements.length === 0) return [];

  const { fit } = await callStructured({
    model: MODEL,
    maxTokens: 4096,
    toolName: 'report_requirement_fit',
    toolDescription: "Report how the candidate's profile measures up to each stated requirement.",
    schema: RequirementFitOutputSchema,
    userContent: `Assess the candidate's base profile against each requirement this job posting states. Report every requirement in job_info.requirements exactly once, copying its text verbatim, and report no requirement the posting did not state.

For each one, give a verdict of "met", "partial" or "unmet". A verdict of "met" or "partial" MUST cite where in the base profile the evidence is, as an index: {"kind":"skill","index":N} into base_profile.skills, or {"kind":"bullet","roleIndex":N,"bulletIndex":M} into base_profile.workExperience[N].bullets. Cite the single strongest piece of evidence. A verdict you cannot point at is "unmet" — never assert a qualification the profile does not show. Set "evidence" to null for "unmet".

Use "note" for one short sentence saying what is missing or only partial, addressed to the candidate. Leave it empty for a plain "met".

${groundingContext(profile, jobInfo)}
`,
  });

  return reconcileRequirementFit(profile, jobInfo, fit);
}
