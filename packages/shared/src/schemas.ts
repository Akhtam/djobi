import { z } from 'zod';
import { HttpUrlSchema } from './httpUrl.js';
import { CustomAnswerSchema, ScreeningAnswersSchema } from './screeningAnswers.js';
// Type-only (no runtime import cycle): used by the compile-time enum equality checks below.
import type { RequirementEvidenceVerdict } from './requirementEvidence.js';
import type { BulletProvenanceVerdict } from './bulletProvenance.js';

/**
 * Fails to typecheck unless `A` and `B` are the same literal set — keeps a hand-written
 * `z.enum([...])` in sync with the TypeScript union it mirrors in another module.
 */
type AssertSameLiterals<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

/** Resume content shared by a Profile work entry and its projected Tailored Resume entry. */
export const ResumeWorkExperienceSchema: z.ZodObject<
  {
    company: z.ZodString;
    title: z.ZodString;
    startDate: z.ZodString;
    endDate: z.ZodNullable<z.ZodString>;
    bullets: z.ZodArray<z.ZodString>;
  },
  z.core.$strip
> = z.object({
  company: z.string(),
  title: z.string(),
  startDate: z.string().describe('e.g. 2022-01'),
  endDate: z.string().nullable().describe('null if current'),
  bullets: z
    .array(z.string())
    .describe("Achievement/responsibility bullet points, in the base profile's own words"),
});

/** One job in a profile's work history, including its tailoring selection controls. */
export const WorkExperienceSchema: z.ZodObject<
  {
    company: z.ZodString;
    title: z.ZodString;
    startDate: z.ZodString;
    endDate: z.ZodNullable<z.ZodString>;
    bullets: z.ZodArray<z.ZodString>;
    maxBullets: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    starredIndices: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
    suppressIfEmpty: z.ZodDefault<z.ZodBoolean>;
  },
  z.core.$strip
> = ResumeWorkExperienceSchema.extend({
  maxBullets: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null)
    .describe("Maximum tailored bullets for this role; null inherits the Profile's default"),
  starredIndices: z
    .array(z.number())
    .default([])
    .describe('Indices of source bullets that every tailored resume must include verbatim'),
  suppressIfEmpty: z
    .boolean()
    .default(false)
    .describe(
      'If tailoring selects zero bullets for this role, omit it from the resume entirely instead of showing it empty',
    ),
}).superRefine(({ bullets, starredIndices }, context) => {
  const unique = new Set(starredIndices);
  const allResolve = starredIndices.every(
    (index) => Number.isInteger(index) && index >= 0 && index < bullets.length,
  );

  if (!allResolve || unique.size !== starredIndices.length) {
    context.addIssue({
      code: 'custom',
      path: ['starredIndices'],
      message: 'Starred bullet indices must be unique and resolve against bullets',
    });
  }
});
/** Inferred type of {@link WorkExperienceSchema}. */
export type WorkExperience = z.infer<typeof WorkExperienceSchema>;

/** One degree in a profile's education history. */
export const EducationSchema: z.ZodObject<
  {
    school: z.ZodString;
    degree: z.ZodString;
    field: z.ZodNullable<z.ZodString>;
    graduationYear: z.ZodNullable<z.ZodString>;
  },
  z.core.$strip
> = z.object({
  school: z.string(),
  degree: z.string(),
  field: z.string().nullable(),
  graduationYear: z.string().nullable(),
});
/** Inferred type of {@link EducationSchema}. */
export type Education = z.infer<typeof EducationSchema>;

/**
 * A reusable STAR-format behavioral or technical anecdote. `answerQuestions` matches `tags`
 * against question text to pick the most relevant stories.
 */
export const StorySchema: z.ZodObject<
  {
    id: z.ZodString;
    title: z.ZodString;
    tags: z.ZodArray<z.ZodString>;
    situation: z.ZodString;
    task: z.ZodString;
    action: z.ZodString;
    result: z.ZodString;
  },
  z.core.$strip
> = z.object({
  id: z
    .string()
    .describe('Stable id, e.g. a slug, so answers can reference which story they drew on'),
  title: z
    .string()
    .describe("Short label, e.g. 'Migrated the billing service under a hard deadline'"),
  tags: z
    .array(z.string())
    .describe(
      "Keywords to match against question text, e.g. ['leadership', 'conflict', 'debugging', 'React', 'incident-response']",
    ),
  situation: z.string().describe('Context: what was going on'),
  task: z.string().describe('What needed to be done, and why it was your responsibility'),
  action: z.string().describe('What you specifically did'),
  result: z.string().describe('The outcome, ideally with a concrete metric or impact'),
});
/** Inferred type of {@link StorySchema}. */
export type Story = z.infer<typeof StorySchema>;

/**
 * A personal, open-source or freelance project. `bullets` mirrors `workExperience` so a project
 * reads like a role: one line of context, then detail bullets.
 */
export const ProjectSchema: z.ZodObject<
  {
    name: z.ZodString;
    description: z.ZodString;
    bullets: z.ZodArray<z.ZodString>;
    link: z.ZodNullable<z.ZodString>;
    technologies: z.ZodNullable<z.ZodArray<z.ZodString>>;
  },
  z.core.$strip
> = z.object({
  name: z.string(),
  description: z.string(),
  bullets: z
    .array(z.string())
    .describe("Achievement/detail bullet points, in the base profile's own words"),
  link: z.string().nullable(),
  technologies: z.array(z.string()).nullable(),
});
/** Inferred type of {@link ProjectSchema}. */
export type Project = z.infer<typeof ProjectSchema>;

/** A professional certification. `date` is whatever date the resume names — issued or expiring. */
export const CertificationSchema: z.ZodObject<
  { name: z.ZodString; issuer: z.ZodString; date: z.ZodString },
  z.core.$strip
> = z.object({
  name: z.string(),
  issuer: z.string(),
  date: z.string(),
});
/** Inferred type of {@link CertificationSchema}. */
export type Certification = z.infer<typeof CertificationSchema>;

/**
 * An award or honor. Separate from {@link CertificationSchema}: awards carry a `description`,
 * certifications don't.
 */
export const AwardSchema: z.ZodObject<
  {
    name: z.ZodString;
    issuer: z.ZodString;
    date: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
> = z.object({
  name: z.string(),
  issuer: z.string(),
  date: z.string(),
  description: z.string().optional(),
});
/** Inferred type of {@link AwardSchema}. */
export type Award = z.infer<typeof AwardSchema>;

/**
 * The whole base Profile, stored as the `profiles.data` jsonb column. Each LLM operation receives
 * only the projection it uses and treats those facts as ground truth.
 */
export const ProfileSchema: z.ZodObject<
  {
    fullName: z.ZodString;
    email: z.ZodString;
    phone: z.ZodNullable<z.ZodString>;
    location: z.ZodNullable<z.ZodString>;
    links: z.ZodObject<
      {
        linkedin: z.ZodNullable<z.ZodString>;
        portfolio: z.ZodNullable<z.ZodString>;
        github: z.ZodNullable<z.ZodString>;
      },
      z.core.$strip
    >;
    summary: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    workExperience: z.ZodArray<typeof WorkExperienceSchema>;
    maxBulletsPerRole: z.ZodDefault<z.ZodNumber>;
    resumePageSize: z.ZodDefault<z.ZodEnum<{ A4: 'A4'; LETTER: 'LETTER' }>>;
    showRolePrefix: z.ZodDefault<z.ZodBoolean>;
    education: z.ZodArray<typeof EducationSchema>;
    projects: z.ZodDefault<z.ZodArray<typeof ProjectSchema>>;
    certifications: z.ZodDefault<z.ZodArray<typeof CertificationSchema>>;
    awards: z.ZodDefault<z.ZodArray<typeof AwardSchema>>;
    skills: z.ZodArray<z.ZodString>;
    stories: z.ZodArray<typeof StorySchema>;
    screeningAnswers: z.ZodDefault<typeof ScreeningAnswersSchema>;
    customAnswers: z.ZodDefault<z.ZodArray<typeof CustomAnswerSchema>>;
  },
  z.core.$strip
> = z.object({
  fullName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  links: z.object({
    linkedin: z.string().nullable(),
    portfolio: z.string().nullable(),
    github: z.string().nullable(),
  }),
  /** Freeform intro paragraph. Defaults to `null` so Profiles saved before it still parse. */
  summary: z.string().nullable().default(null),
  workExperience: z.array(WorkExperienceSchema),
  maxBulletsPerRole: z
    .number()
    .int()
    .nonnegative()
    .default(6)
    .describe('Default maximum number of bullets selected for each tailored resume role'),
  resumePageSize: z
    .enum(['A4', 'LETTER'])
    .default('A4')
    .describe('Paper size used when rendering tailored resume PDFs'),
  showRolePrefix: z
    .boolean()
    .default(true)
    .describe('Whether resume role titles are prefixed with "Role:"'),
  education: z.array(EducationSchema),
  /** Projects, certifications and awards; default `[]` so older Profiles still parse. */
  projects: z.array(ProjectSchema).default([]),
  certifications: z.array(CertificationSchema).default([]),
  awards: z.array(AwardSchema).default([]),
  skills: z.array(z.string()),
  stories: z
    .array(StorySchema)
    .describe(
      'Reusable STAR-format behavioral/technical anecdotes, drawn on when drafting freeform question answers',
    ),
  /**
   * Screening answers, filled verbatim rather than drafted — see `screeningAnswers.ts`. Defaults
   * to `{}` so older Profiles still parse (jsonb has no migration).
   */
  screeningAnswers: ScreeningAnswersSchema.default({}),
  customAnswers: z
    .array(CustomAnswerSchema)
    .default([])
    .describe("Prepared answers to recurring questions the fixed screening topics don't cover"),
});
/** Inferred type of {@link ProfileSchema}. */
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * An empty Profile: the starting form for a new candidate and the base {@link parseProfile}
 * completes against. The schema itself deliberately has no defaults for these, so
 * `POST /profile` still rejects a body missing e.g. `fullName`.
 */
export const EMPTY_PROFILE: Profile = {
  fullName: '',
  email: '',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  projects: [],
  certifications: [],
  awards: [],
  skills: [],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

/**
 * Completes a stored Profile against {@link EMPTY_PROFILE} and validates it, so rows saved before a
 * field existed don't crash forms that bind to it. `links` is merged key by key (a plain spread
 * would drop newer keys like `github`). Falls back to the empty Profile if it still doesn't parse.
 */
export function parseProfile(value: unknown): Profile {
  const stored = (value ?? {}) as Partial<Profile>;
  const parsed = ProfileSchema.safeParse({
    ...EMPTY_PROFILE,
    ...stored,
    links: { ...EMPTY_PROFILE.links, ...stored.links },
  });

  return parsed.success ? parsed.data : EMPTY_PROFILE;
}

/**
 * What `POST /profile/extract-resume` returns: the Profile fields a resume can honestly supply.
 * No `stories`, `screeningAnswers`, `customAnswers` or bullet-selection controls — a resume
 * doesn't state them — so `workExperience` uses {@link ResumeWorkExperienceSchema}.
 *
 * Everything is nullable or may be empty: a partial extraction must leave blanks for the candidate
 * to fill, never invented values. Looser than {@link ProfileSchema} because it is a draft reviewed
 * before saving.
 */
export const ExtractedProfileSchema: z.ZodObject<
  {
    fullName: z.ZodNullable<z.ZodString>;
    email: z.ZodNullable<z.ZodString>;
    phone: z.ZodNullable<z.ZodString>;
    location: z.ZodNullable<z.ZodString>;
    links: z.ZodObject<
      {
        linkedin: z.ZodNullable<z.ZodString>;
        portfolio: z.ZodNullable<z.ZodString>;
        github: z.ZodNullable<z.ZodString>;
      },
      z.core.$strip
    >;
    summary: z.ZodNullable<z.ZodString>;
    workExperience: z.ZodArray<typeof ResumeWorkExperienceSchema>;
    education: z.ZodArray<typeof EducationSchema>;
    skills: z.ZodArray<z.ZodString>;
    projects: z.ZodArray<typeof ProjectSchema>;
    certifications: z.ZodArray<typeof CertificationSchema>;
    awards: z.ZodArray<typeof AwardSchema>;
  },
  z.core.$strip
> = z.object({
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  links: z.object({
    linkedin: z.string().nullable(),
    portfolio: z.string().nullable(),
    github: z.string().nullable(),
  }),
  summary: z.string().nullable(),
  workExperience: z.array(ResumeWorkExperienceSchema),
  education: z.array(EducationSchema),
  skills: z.array(z.string()),
  projects: z.array(ProjectSchema),
  certifications: z.array(CertificationSchema),
  awards: z.array(AwardSchema),
});
/** Inferred type of {@link ExtractedProfileSchema}. */
export type ExtractedProfile = z.infer<typeof ExtractedProfileSchema>;

/**
 * How the posting phrased a requirement: under a "Requirements" or "Nice to have" heading, or
 * neither (`'unspecified'`, the common case). Legacy rows lift to `'unspecified'`, not
 * `'required'`.
 */
export const RequirementKindSchema: z.ZodEnum<{
  preferred: 'preferred';
  required: 'required';
  unspecified: 'unspecified';
}> = z.enum(['required', 'preferred', 'unspecified']);
/** Inferred type of {@link RequirementKindSchema}. */
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

/**
 * How much a requirement matters *in this posting* — never a claim about the candidate, and never a
 * number: five bands, because the evidence can't support finer grain and a score invites arithmetic
 * nobody has licensed. Distinct from `kind` (how the posting phrased it): one heading can hold both
 * boilerplate and a must-have.
 */
export const RequirementImportanceSchema: z.ZodEnum<{
  critical: 'critical';
  high: 'high';
  'low-signal': 'low-signal';
  meaningful: 'meaningful';
  preferred: 'preferred';
}> = z.enum(['critical', 'high', 'meaningful', 'preferred', 'low-signal']);
/** Inferred type of {@link RequirementImportanceSchema}. */
export type RequirementImportance = z.infer<typeof RequirementImportanceSchema>;

/**
 * Bands, most decisive first — derived from the enum (declared in that order) so sorting and the
 * dashboard's grouping can't drift.
 */
export const IMPORTANCE_BANDS: ('critical' | 'high' | 'low-signal' | 'meaningful' | 'preferred')[] =
  RequirementImportanceSchema.options;

/**
 * Where a {@link RequirementImportanceSchema} band came from; read by the cap in
 * `requirementImportance.ts`.
 *
 * - `stated` — the posting marks it required (or it's in the title); carries a verbatim
 *   `postingSignal`.
 * - `structural` — the posting's layout carries the weight (section, repetition, position).
 * - `inferred` — market knowledge of how such roles are screened. Allowed, but labelled so it can
 *   be capped.
 *
 * Not named `RequirementEvidence*`: that word belongs to what the candidate's resume shows.
 */
export const ImportanceTierSchema: z.ZodEnum<{
  inferred: 'inferred';
  stated: 'stated';
  structural: 'structural';
}> = z.enum(['stated', 'structural', 'inferred']);
/** Inferred type of {@link ImportanceTierSchema}. */
export type ImportanceTier = z.infer<typeof ImportanceTierSchema>;

/**
 * One qualification a posting states. `yearsOfExperience` is null unless the posting gives a
 * number.
 *
 * `importance`/`importanceTier`/`postingSignal` default to `null` ("not assessed" — never a low
 * band) so older rows parse. The schema stays permissive: the "`inferred` can't be decisive" rule
 * is enforced at extraction by `normalizeRequirementImportance`, since a refinement here would make
 * stored rows unreadable.
 */
export const JobRequirementSchema: z.ZodObject<
  {
    text: z.ZodString;
    kind: typeof RequirementKindSchema;
    yearsOfExperience: z.ZodNullable<z.ZodNumber>;
    importance: z.ZodDefault<z.ZodNullable<typeof RequirementImportanceSchema>>;
    importanceTier: z.ZodDefault<z.ZodNullable<typeof ImportanceTierSchema>>;
    postingSignal: z.ZodDefault<z.ZodNullable<z.ZodString>>;
  },
  z.core.$strip
> = z.object({
  text: z.string().describe("The requirement in the posting's own words"),
  kind: RequirementKindSchema,
  yearsOfExperience: z
    .number()
    .nullable()
    .describe('Years the posting states for this requirement, if any; null otherwise'),
  importance: RequirementImportanceSchema.nullable()
    .default(null)
    .describe('How much this requirement matters in this posting; null if not assessed'),
  importanceTier: ImportanceTierSchema.nullable()
    .default(null)
    .describe('Where the importance band came from; null travels with a null band'),
  postingSignal: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'The posting wording the band rests on: a verbatim quote for stated, a section or repetition reference for structural, null for inferred',
    ),
});
/** Inferred type of {@link JobRequirementSchema}. */
export type JobRequirement = z.infer<typeof JobRequirementSchema>;

/**
 * A {@link JobRequirement}, or the legacy bare string, which lifts to `kind: 'unspecified'` with
 * later fields null. A tolerant read, not a migration — consumers only ever see the object shape.
 */
export const JobRequirementInputSchema: z.ZodUnion<
  readonly [
    z.ZodPipe<
      z.ZodString,
      z.ZodTransform<
        {
          text: string;
          kind: 'preferred' | 'required' | 'unspecified';
          yearsOfExperience: number | null;
          importance: 'critical' | 'high' | 'low-signal' | 'meaningful' | 'preferred' | null;
          importanceTier: 'inferred' | 'stated' | 'structural' | null;
          postingSignal: string | null;
        },
        string
      >
    >,
    typeof JobRequirementSchema,
  ]
> = z.union([
  z.string().transform((text): JobRequirement => ({
    text,
    kind: 'unspecified',
    yearsOfExperience: null,
    importance: null,
    importanceTier: null,
    postingSignal: null,
  })),
  JobRequirementSchema,
]);

/**
 * Validator for `requirementEvidence.ts`'s verdicts, needed by `Application.requirementEvidence`.
 * Written out rather than derived to avoid a runtime import cycle; checked for drift below.
 */
export const RequirementEvidenceVerdictSchema: z.ZodEnum<{
  'direct-evidence': 'direct-evidence';
  'needs-confirmation': 'needs-confirmation';
  'omitted-profile-evidence': 'omitted-profile-evidence';
  'skill-only': 'skill-only';
  unsupported: 'unsupported';
}> = z.enum([
  'direct-evidence',
  'skill-only',
  'omitted-profile-evidence',
  'needs-confirmation',
  'unsupported',
]);
// No exported type: import `RequirementEvidenceVerdict` from `requirementEvidence.ts`.
// Fails to typecheck if the two lists drift.
type _RequirementEvidenceVerdictsMatch = AssertSameLiterals<
  z.infer<typeof RequirementEvidenceVerdictSchema>,
  RequirementEvidenceVerdict
>;
const _requirementEvidenceVerdictsMatch: _RequirementEvidenceVerdictsMatch = true;
void _requirementEvidenceVerdictsMatch;

export const RequirementEvidenceSchema: z.ZodObject<
  {
    requirement: typeof JobRequirementSchema;
    verdict: typeof RequirementEvidenceVerdictSchema;
    evidence: z.ZodNullable<z.ZodString>;
  },
  z.core.$strip
> = z.object({
  requirement: JobRequirementSchema,
  verdict: RequirementEvidenceVerdictSchema,
  evidence: z.string().nullable(),
});
/** Inferred type of {@link RequirementEvidenceSchema}. */
export type RequirementEvidenceEntry = z.infer<typeof RequirementEvidenceSchema>;

/**
 * A keyword's category. `'soft-skill'` gets no coverage badge: literal matching can't tell that
 * "mentored" evidences "leadership", and a wrong `missing` is worse than no verdict.
 */
export const KeywordCategorySchema: z.ZodEnum<{
  domain: 'domain';
  framework: 'framework';
  language: 'language';
  platform: 'platform';
  'soft-skill': 'soft-skill';
  tool: 'tool';
}> = z.enum(['language', 'framework', 'tool', 'platform', 'domain', 'soft-skill']);
/** Inferred type of {@link KeywordCategorySchema}. */
export type KeywordCategory = z.infer<typeof KeywordCategorySchema>;

/**
 * A term worth echoing from a posting, grouped by {@link KeywordCategory} for analytics.
 * `category` is null when absent or unclear — never guessed.
 *
 * `postingSpelling` is the posting's own wording (`K8s` for `Kubernetes`), or null if it used the
 * canonical form. `keywordCoverage.ts` matches both.
 */
export const JobKeywordSchema: z.ZodObject<
  {
    term: z.ZodString;
    category: z.ZodNullable<typeof KeywordCategorySchema>;
    postingSpelling: z.ZodDefault<z.ZodNullable<z.ZodString>>;
  },
  z.core.$strip
> = z.object({
  term: z.string().describe('Canonical, expanded, industry-standard name, e.g. Kubernetes not K8s'),
  category: KeywordCategorySchema.nullable(),
  postingSpelling: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "The posting's own spelling of this term, e.g. K8s; null if it already used the canonical form",
    ),
});
/** Inferred type of {@link JobKeywordSchema}. */
export type JobKeyword = z.infer<typeof JobKeywordSchema>;

/**
 * A {@link JobKeyword}, or the legacy bare string, lifted to `category: null, postingSpelling:
 * null` on read.
 */
export const JobKeywordInputSchema: z.ZodUnion<
  readonly [
    z.ZodPipe<
      z.ZodString,
      z.ZodTransform<
        {
          term: string;
          category: 'domain' | 'framework' | 'language' | 'platform' | 'soft-skill' | 'tool' | null;
          postingSpelling: string | null;
        },
        string
      >
    >,
    typeof JobKeywordSchema,
  ]
> = z.union([
  z.string().transform((term): JobKeyword => ({ term, category: null, postingSpelling: null })),
  JobKeywordSchema,
]);

/** Structured Job Info that `extractJob` pulls from the candidate-reviewed Job Description. */
export const JobInfoSchema: z.ZodObject<
  {
    company: z.ZodString;
    team: z.ZodNullable<z.ZodString>;
    roleTitle: z.ZodString;
    seniority: z.ZodNullable<z.ZodString>;
    location: z.ZodNullable<z.ZodString>;
    requirements: z.ZodArray<typeof JobRequirementInputSchema>;
    keywords: z.ZodArray<typeof JobKeywordInputSchema>;
  },
  z.core.$strip
> = z.object({
  company: z.string(),
  team: z.string().nullable().describe('Team or department, if mentioned'),
  roleTitle: z.string(),
  seniority: z.string().nullable().describe('e.g. Junior, Senior, Staff'),
  location: z.string().nullable(),
  requirements: z
    .array(JobRequirementInputSchema)
    .describe('Concrete required/preferred qualifications extracted from the posting'),
  keywords: z
    .array(JobKeywordInputSchema)
    .describe('Skills/technologies/domain terms worth echoing in a tailored resume'),
});
/** Inferred type of {@link JobInfoSchema}. */
export type JobInfo = z.infer<typeof JobInfoSchema>;

/**
 * A resume tailored to one job by `tailorResume` — a subset of {@link ProfileSchema} (skills and
 * work experience only).
 */
export const TailoredResumeSchema: z.ZodObject<
  {
    skills: z.ZodArray<z.ZodString>;
    workExperience: z.ZodArray<typeof ResumeWorkExperienceSchema>;
  },
  z.core.$strip
> = z.object({
  skills: z
    .array(z.string())
    .describe("The base profile's complete skills list, unchanged and in profile order"),
  workExperience: z.array(
    ResumeWorkExperienceSchema.extend({
      bullets: z
        .array(z.string())
        .describe(
          'Reworded/reordered bullets emphasizing relevance to the job; must not invent facts not present in the base profile',
        ),
    }),
  ),
});
/** Inferred type of {@link TailoredResumeSchema}. */
export type TailoredResume = z.infer<typeof TailoredResumeSchema>;

/**
 * The Profile projected into {@link TailoredResumeSchema} with nothing reworded, reordered or
 * dropped — the Base Resume.
 *
 * Stored for manual Applications (their resume is the candidate's own), and used by
 * `tailorResume.ts` as the full bullet bank for Profile-side evidence. Takes only the two fields
 * it reads.
 */
export function baseResumeOf(profile: Pick<Profile, 'skills' | 'workExperience'>): TailoredResume {
  return {
    skills: profile.skills,
    workExperience: profile.workExperience.map(
      ({ company, title, startDate, endDate, bullets }) => ({
        company,
        title,
        startDate,
        endDate,
        bullets,
      }),
    ),
  };
}

/** One drafted answer to one detected `question` field, produced by `answerQuestions`. */
export const QuestionAnswerSchema: z.ZodObject<
  {
    fieldId: z.ZodString;
    question: z.ZodString;
    answer: z.ZodString;
    sourceStoryIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
  },
  z.core.$strip
> = z.object({
  fieldId: z.string().describe('Matches DetectedField.id'),
  question: z.string(),
  answer: z.string(),
  /**
   * Defaulted, not required: the model often omits it when no story was used, and since the batch
   * is validated as one object a single omission would fail every answer.
   */
  sourceStoryIds: z
    .array(z.string())
    .default([])
    .describe('Story.id values this answer drew on, if any'),
});
/** Inferred type of {@link QuestionAnswerSchema}. */
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

/**
 * Where an Application sits in the interview pipeline, in pipeline order. Never null; defaults to
 * `'applied'`.
 *
 * `rejected_ats` (screened out before any human) and `rejected` (after contact) are separate enum
 * values rather than a flag, so they can't disagree with `stage`. Which stage a `rejected` row
 * came from isn't recorded.
 *
 * There is no draft/submitted status: nothing in the flow can reliably observe a submission, so
 * don't add one without such an event.
 */
export const ApplicationStageSchema: z.ZodEnum<{
  applied: 'applied';
  offer: 'offer';
  onsite: 'onsite';
  phone_screen: 'phone_screen';
  rejected: 'rejected';
  rejected_ats: 'rejected_ats';
}> = z.enum(['applied', 'rejected_ats', 'phone_screen', 'onsite', 'offer', 'rejected']);
/** Inferred type of {@link ApplicationStageSchema}. */
export type ApplicationStage = z.infer<typeof ApplicationStageSchema>;

/**
 * How a note is filed. Interview questions are split out so "what did they ask me technically" is
 * answerable without rereading every note.
 */
export const NoteCategorySchema: z.ZodEnum<{
  behavioral: 'behavioral';
  general: 'general';
  technical: 'technical';
}> = z.enum(['technical', 'behavioral', 'general']);
/** Inferred type of {@link NoteCategorySchema}. */
export type NoteCategory = z.infer<typeof NoteCategorySchema>;

/**
 * One timestamped entry in an Application's notes log — appended, never edited. `id` and
 * `createdAt` are assigned by the server.
 */
export const NoteSchema: z.ZodObject<
  {
    id: z.ZodString;
    category: typeof NoteCategorySchema;
    text: z.ZodString;
    createdAt: z.ZodString;
  },
  z.core.$strip
> = z.object({
  id: z.string(),
  category: NoteCategorySchema,
  text: z.string(),
  createdAt: z.string(),
});
/** Inferred type of {@link NoteSchema}. */
export type Note = z.infer<typeof NoteSchema>;

/** `POST /applications/:id/notes` body: {@link NoteSchema} minus server-assigned fields. */
export const NewNoteSchema: z.ZodObject<
  { category: typeof NoteCategorySchema; text: z.ZodString },
  z.core.$strip
> = NoteSchema.omit({ id: true, createdAt: true });
/** Inferred type of {@link NewNoteSchema}. */
export type NewNote = z.infer<typeof NewNoteSchema>;

/**
 * How an Application came to exist: `'autofill'` (the Application Pipeline) or `'manual'` (the
 * candidate applied themselves and logged it). Distinguishes "djobi wrote this resume" from "this
 * is my own Profile". Defaults to `'autofill'` at every write boundary.
 */
export const ApplicationSourceSchema: z.ZodEnum<{ autofill: 'autofill'; manual: 'manual' }> =
  z.enum(['autofill', 'manual']);
/** Inferred type of {@link ApplicationSourceSchema}. */
export type ApplicationSource = z.infer<typeof ApplicationSourceSchema>;

/**
 * Compatibility marker for the shape `extractJob` and `tailorResume` produce, stamped on every
 * saved Application so later changes know which rows they can re-derive. Bump only on a material
 * shape change, not prompt tweaks.
 */
export const EXTRACTION_VERSION = '2026-09-10';

/** Mirrors `bulletProvenance.ts`'s verdict type (see {@link RequirementEvidenceVerdictSchema}). */
export const BulletProvenanceVerdictSchema: z.ZodEnum<{
  reworded: 'reworded';
  unmatched: 'unmatched';
  verbatim: 'verbatim';
}> = z.enum(['verbatim', 'reworded', 'unmatched']);
// If the enum above and `bulletProvenance.ts`'s own union ever drift, this line fails to
// typecheck instead of the schema silently accepting or rejecting values the function can return.
type _BulletProvenanceVerdictsMatch = AssertSameLiterals<
  z.infer<typeof BulletProvenanceVerdictSchema>,
  BulletProvenanceVerdict
>;
const _bulletProvenanceVerdictsMatch: _BulletProvenanceVerdictsMatch = true;
void _bulletProvenanceVerdictsMatch;

/**
 * One Tailored Resume bullet's likely Profile source, computed once at save time so the audit trail
 * reflects what was saved even after the Profile changes.
 */
export const BulletProvenanceEntrySchema: z.ZodObject<
  {
    company: z.ZodString;
    title: z.ZodString;
    bullet: z.ZodString;
    verdict: typeof BulletProvenanceVerdictSchema;
    source: z.ZodNullable<z.ZodString>;
  },
  z.core.$strip
> = z.object({
  company: z.string(),
  title: z.string(),
  bullet: z.string(),
  verdict: BulletProvenanceVerdictSchema,
  source: z.string().nullable(),
});
// No `export type` here either, for the same reason: `bulletProvenance.ts` already exports
// `BulletProvenanceEntry`, and this schema is written to match it rather than be its source.

/**
 * One persisted `applications` row: the generated snapshot plus Stage and Notes. Autofill and
 * manual Applications share this shape; see {@link ApplicationSourceSchema}.
 */
export const ApplicationSchema: z.ZodObject<
  {
    id: z.ZodString;
    company: z.ZodString;
    roleTitle: z.ZodString;
    jobUrl: z.ZodString;
    jobInfo: typeof JobInfoSchema;
    tailoredResume: typeof TailoredResumeSchema;
    answers: z.ZodArray<typeof QuestionAnswerSchema>;
    source: z.ZodEnum<{ autofill: 'autofill'; manual: 'manual' }>;
    stage: typeof ApplicationStageSchema;
    notes: z.ZodArray<typeof NoteSchema>;
    rawDescription: z.ZodNullable<z.ZodString>;
    extractionVersion: z.ZodNullable<z.ZodString>;
    requirementEvidence: z.ZodNullable<z.ZodArray<typeof RequirementEvidenceSchema>>;
    bulletProvenance: z.ZodNullable<z.ZodArray<typeof BulletProvenanceEntrySchema>>;
    createdAt: z.ZodString;
  },
  z.core.$strip
> = z.object({
  id: z.string(),
  company: z.string(),
  roleTitle: z.string(),
  jobUrl: z.string(),
  jobInfo: JobInfoSchema,
  tailoredResume: TailoredResumeSchema,
  answers: z.array(QuestionAnswerSchema),
  source: ApplicationSourceSchema,
  stage: ApplicationStageSchema,
  notes: z.array(NoteSchema),
  /**
   * The posting text as analyzed (`extractJob`'s input), kept so extraction can be re-run later.
   * `null` for older rows and for manual entries without posting text.
   */
  rawDescription: z.string().nullable(),
  /** {@link EXTRACTION_VERSION} when this row was written; `null` for older rows. */
  extractionVersion: z.string().nullable(),
  /**
   * `requirementEvidence(tailoredResume, jobInfo, profile)` computed once at save time and never
   * recomputed. `null` for older rows or if the Profile couldn't be read then.
   */
  requirementEvidence: z.array(RequirementEvidenceSchema).nullable(),
  /**
   * `bulletProvenance(tailoredResume, profile)`, computed once at save time like the field above.
   */
  bulletProvenance: z.array(BulletProvenanceEntrySchema).nullable(),
  createdAt: z.string(),
});
/** Inferred type of {@link ApplicationSchema}. */
export type Application = z.infer<typeof ApplicationSchema>;

/**
 * `POST /applications` body: {@link ApplicationSchema} minus `id`/`createdAt`. `stage` and
 * `notes` must stay defaulted — the extension's save posts neither.
 */
export const NewApplicationSchema: z.ZodObject<
  {
    company: z.ZodString;
    roleTitle: z.ZodString;
    jobInfo: typeof JobInfoSchema;
    tailoredResume: typeof TailoredResumeSchema;
    answers: z.ZodArray<typeof QuestionAnswerSchema>;
    jobUrl: z.ZodURL;
    source: z.ZodDefault<z.ZodEnum<{ autofill: 'autofill'; manual: 'manual' }>>;
    stage: z.ZodDefault<typeof ApplicationStageSchema>;
    notes: z.ZodDefault<z.ZodArray<typeof NoteSchema>>;
    rawDescription: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    extractionVersion: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    requirementEvidence: z.ZodDefault<z.ZodNullable<z.ZodArray<typeof RequirementEvidenceSchema>>>;
    bulletProvenance: z.ZodDefault<z.ZodNullable<z.ZodArray<typeof BulletProvenanceEntrySchema>>>;
  },
  z.core.$strip
> = ApplicationSchema.omit({ id: true, createdAt: true }).extend({
  // Older rows may lack a URL; only new writes are validated. `HttpUrlSchema`, not `.url()`, so a
  // `javascript:` URL can't be stored and rendered as a link (see `httpUrl.ts`).
  jobUrl: HttpUrlSchema,
  source: ApplicationSourceSchema.default('autofill'),
  stage: ApplicationStageSchema.default('applied'),
  notes: z.array(NoteSchema).default([]),
  rawDescription: z.string().nullable().default(null),
  // Auto-stamped: a caller never has to know this exists to get an accurate value, the same reason
  // `stage`/`notes` default rather than requiring every existing caller to state them.
  extractionVersion: z.string().nullable().default(EXTRACTION_VERSION),
  requirementEvidence: z.array(RequirementEvidenceSchema).nullable().default(null),
  bulletProvenance: z.array(BulletProvenanceEntrySchema).nullable().default(null),
});
/** Inferred type of {@link NewApplicationSchema}. */
export type NewApplication = z.infer<typeof NewApplicationSchema>;

/**
 * What a client sends to `POST /applications`: the input side, where defaulted fields are
 * optional (`NewApplication` is the parsed output, where they're required).
 */
export type NewApplicationRequest = z.input<typeof NewApplicationSchema>;

/**
 * The editable snapshot of a saved Application. Omits `stage`/`notes` (owned by the record, so
 * a re-save never overwrites them) and `source` (a re-save can't relabel provenance).
 */
export const ApplicationSnapshotSchema: z.ZodObject<
  {
    company: z.ZodString;
    roleTitle: z.ZodString;
    jobInfo: typeof JobInfoSchema;
    tailoredResume: typeof TailoredResumeSchema;
    answers: z.ZodArray<typeof QuestionAnswerSchema>;
    jobUrl: z.ZodURL;
    rawDescription: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    extractionVersion: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    requirementEvidence: z.ZodDefault<z.ZodNullable<z.ZodArray<typeof RequirementEvidenceSchema>>>;
    bulletProvenance: z.ZodDefault<z.ZodNullable<z.ZodArray<typeof BulletProvenanceEntrySchema>>>;
  },
  z.core.$strict
> = NewApplicationSchema.omit({
  source: true,
  stage: true,
  notes: true,
}).strict();
export type ApplicationSnapshot = z.infer<typeof ApplicationSnapshotSchema>;
