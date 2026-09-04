/**
 * Applications for the test suite. **Not shipped** — nothing under `main.tsx` imports this, and the
 * running app always talks to the real backend.
 *
 * Typed as `Application[]` rather than left inferred on purpose: these stand in for rows the
 * backend produces, so a change to `ApplicationSchema` must break this file's build rather than
 * quietly leave the UI developed against a shape that no longer exists.
 *
 * The set is chosen to cover every branch the UI has, not to look plausible:
 * one row per `ApplicationStage`, both `ApplicationSource`s, an empty notes log, a log with all
 * three note categories, an application with no drafted answers, and one deliberately oversized row
 * (long role title, twelve resume bullets, long answers) to stress the layout.
 *
 * Most `jobInfo.requirements`/`.keywords` below are written directly in the shape `JobInfoSchema`
 * now states — `{ text, kind, yearsOfExperience }` and `{ term, category }` — with enough spread
 * across `kind` and `category` to exercise the required/preferred roll-up and category grouping.
 * The Stripe row is deliberately left as bare strings, its earliest `createdAt` standing in for a
 * row logged before this shape existed, and is run through `JobInfoSchema.parse` so it exercises
 * the tolerant read the same way a stored row would rather than merely satisfying the type.
 *
 * `fixtureProfile` below is `getProfile`'s "ready" state — the third state, `null`, is what
 * `createFixtureDashboardClient` defaults to, since most existing callers neither know nor care
 * about it. Its `skills` deliberately cover some of the terms `fixtureApplications` extracts
 * (TypeScript, React, GraphQL, Go) and miss others (Java, Ruby, Next.js, observability, ...), so a
 * coverage report built over it has both verdicts to show rather than a wall of one.
 */
import { JobInfoSchema } from '@djobi/shared';
import type { Application, ExtractedProfile, Profile } from '@djobi/shared';

export const fixtureApplications: Application[] = [
  {
    id: 'app-anthropic-manual',
    company: 'Anthropic',
    roleTitle: 'Member of Technical Staff, Product',
    jobUrl: 'https://job-boards.greenhouse.io/anthropic/jobs/4551221008',
    createdAt: '2026-03-19T08:05:00.000Z',
    source: 'manual',
    stage: 'rejected_ats',
    jobInfo: {
      company: 'Anthropic',
      team: null,
      roleTitle: 'Member of Technical Staff, Product',
      seniority: null,
      location: 'Remote',
      requirements: [
        { text: 'Strong React and TypeScript', kind: 'required', yearsOfExperience: null },
        {
          text: 'Comfort owning a product surface end to end',
          kind: 'preferred',
          yearsOfExperience: null,
        },
      ],
      keywords: [
        { term: 'React', category: 'framework', postingSpelling: null },
        { term: 'TypeScript', category: 'language', postingSpelling: null },
        { term: 'Next.js', category: 'framework', postingSpelling: null },
      ],
    },
    // The base profile as-is — nothing was tailored, because the candidate applied themselves.
    tailoredResume: {
      skills: ['TypeScript', 'React', 'Node.js', 'Postgres'],
      workExperience: [
        {
          company: 'Northwind',
          title: 'Software Engineer',
          startDate: '2021-06',
          endDate: null,
          bullets: [
            'Built and shipped the customer-facing billing portal.',
            'Cut p95 checkout latency from 1.8s to 400ms.',
          ],
        },
      ],
    },
    answers: [],
    notes: [],
    rawDescription: null,
    extractionVersion: null,
    requirementEvidence: null,
    bulletProvenance: null,
  },
  {
    id: 'app-brex',
    company: 'Brex',
    roleTitle: 'Senior Frontend Engineer',
    jobUrl: 'https://boards.greenhouse.io/brex/jobs/4012',
    createdAt: '2026-03-14T09:12:00.000Z',
    source: 'autofill',
    stage: 'onsite',
    jobInfo: {
      company: 'Brex',
      team: 'Infrastructure',
      roleTitle: 'Senior Frontend Engineer',
      seniority: 'Senior',
      location: 'Remote (US)',
      requirements: [
        {
          text: '5+ years building production React applications',
          kind: 'required',
          yearsOfExperience: 5,
        },
        {
          text: 'Experience with design systems at scale',
          kind: 'preferred',
          yearsOfExperience: null,
        },
        {
          text: 'Comfort owning a service end to end',
          kind: 'unspecified',
          yearsOfExperience: null,
        },
        {
          text: 'Experience improving frontend performance at scale',
          kind: 'preferred',
          yearsOfExperience: null,
        },
      ],
      keywords: [
        { term: 'React', category: 'framework', postingSpelling: null },
        { term: 'TypeScript', category: 'language', postingSpelling: null },
        { term: 'design systems', category: 'domain', postingSpelling: null },
        { term: 'GraphQL', category: 'tool', postingSpelling: null },
      ],
    },
    tailoredResume: {
      skills: ['TypeScript', 'React', 'GraphQL', 'Design systems', 'Node.js'],
      workExperience: [
        {
          company: 'Northwind',
          title: 'Senior Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: [
            'Led the migration of a 400-component design system to CSS custom properties, cutting bundle size 18%.',
            'Owned the checkout surface end to end, from GraphQL schema through to the React client.',
          ],
        },
        {
          company: 'Halcyon',
          title: 'Engineer',
          startDate: '2019-06',
          endDate: '2021-12',
          bullets: ['Built the internal component library adopted by six product teams.'],
        },
      ],
    },
    answers: [
      {
        fieldId: 'q-why',
        question: 'Why do you want to work at Brex?',
        answer:
          'The infrastructure team owns the surfaces every other team builds on, which is the work I have gravitated to twice now — most recently owning a design-system migration that touched 400 components.',
        sourceStoryIds: ['design-system-migration'],
      },
      {
        fieldId: 'q-hard',
        question: 'Describe a technically difficult problem you solved.',
        answer:
          'A race between an optimistic cache write and a refetch was dropping one in every few hundred checkout submissions. I reproduced it by forcing the refetch to resolve late, then made the write idempotent against a request id.',
        sourceStoryIds: ['checkout-race'],
      },
      {
        fieldId: 'q-remote',
        question: 'How do you work effectively in a remote team?',
        answer:
          'I write decisions down where they can be found later. Most of what a colocated team gets from proximity, a remote team can get from a searchable written record.',
        sourceStoryIds: [],
      },
      {
        fieldId: 'q-salary',
        question: 'What are your salary expectations?',
        answer: 'Open to discussing a range aligned with the level and location.',
        sourceStoryIds: [],
      },
    ],
    notes: [
      {
        id: 'note-brex-1',
        category: 'general',
        text: 'Recruiter screen booked for the 18th. Mentioned the team is six engineers.',
        createdAt: '2026-03-15T14:02:00.000Z',
      },
      {
        id: 'note-brex-2',
        category: 'technical',
        text: 'Asked to debug a race in a React effect, live. Wanted me to reason about the cleanup function before touching anything.',
        createdAt: '2026-03-18T14:14:00.000Z',
      },
      {
        id: 'note-brex-3',
        category: 'behavioral',
        text: 'Tell me about a time you disagreed with a technical decision and lost. They pushed hard on what I did afterwards.',
        createdAt: '2026-03-22T10:30:00.000Z',
      },
    ],
    /*
     * The one fixture carrying the posting it was analyzed from. Every other row leaves it `null`,
     * standing in for the rows written before the column existed — so the detail page's Posting tab
     * has both cases to render, and the empty one is not a hypothetical.
     */
    rawDescription: [
      'About the role',
      '',
      'We are looking for a Senior Frontend Engineer to join our Infrastructure team. You will own',
      'the surfaces every other engineering team builds on, from the design system through to the',
      'tooling that ships it.',
      '',
      'What we are looking for',
      '',
      '- 5+ years building production React applications',
      '- Experience with design systems at scale',
      '- Comfort owning a service end to end',
      '- Experience improving frontend performance at scale',
    ].join('\n'),
    extractionVersion: 'extract-job@3',
    /*
     * The scored row. Every other fixture leaves this `null`, standing in for the rows written
     * before the field existed — so the analytics roll-up has the mixed history that is the normal
     * case to report over, not a uniformly scored set that would never exercise its own caveat.
     * One entry per requirement above, in the same order, carrying the three verdicts the
     * requirements panel renders differently: the dropped bullet is in `fixtureProfile` and
     * missing from this row's `tailoredResume`, which is exactly what that verdict means.
     */
    requirementEvidence: [
      {
        requirement: {
          text: '5+ years building production React applications',
          kind: 'required',
          yearsOfExperience: 5,
        },
        verdict: 'needs-confirmation',
        evidence: null,
      },
      {
        requirement: {
          text: 'Experience with design systems at scale',
          kind: 'preferred',
          yearsOfExperience: null,
        },
        verdict: 'direct-evidence',
        evidence:
          'Led the migration of a 400-component design system to CSS custom properties, cutting bundle size 18%.',
      },
      {
        requirement: {
          text: 'Comfort owning a service end to end',
          kind: 'unspecified',
          yearsOfExperience: null,
        },
        verdict: 'direct-evidence',
        evidence:
          'Owned the checkout surface end to end, from GraphQL schema through to the React client.',
      },
      {
        requirement: {
          text: 'Experience improving frontend performance at scale',
          kind: 'preferred',
          yearsOfExperience: null,
        },
        verdict: 'omitted-profile-evidence',
        evidence:
          'Reduced p99 checkout latency from 2.4s to 480ms by moving fee calculation off the request path.',
      },
    ],
    bulletProvenance: null,
  },
  {
    id: 'app-sonar',
    company: 'Sonar',
    roleTitle: 'Staff Engineer, Platform',
    jobUrl: 'https://jobs.lever.co/sonarsource/8a1f2c33/apply',
    createdAt: '2026-03-11T16:40:00.000Z',
    source: 'autofill',
    stage: 'applied',
    jobInfo: {
      company: 'Sonar',
      team: null,
      roleTitle: 'Staff Engineer, Platform',
      seniority: 'Staff',
      location: 'Geneva, Switzerland',
      requirements: [
        { text: 'Deep JVM experience', kind: 'required', yearsOfExperience: null },
        { text: 'Static analysis background a plus', kind: 'preferred', yearsOfExperience: null },
      ],
      keywords: [
        { term: 'Java', category: 'language', postingSpelling: null },
        { term: 'static analysis', category: 'domain', postingSpelling: null },
        { term: 'platform', category: 'domain', postingSpelling: null },
      ],
    },
    tailoredResume: {
      skills: ['Java', 'TypeScript', 'Static analysis'],
      workExperience: [
        {
          company: 'Northwind',
          title: 'Senior Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: ['Built the lint rule set enforcing the design system across twelve repos.'],
        },
      ],
    },
    answers: [],
    notes: [],
    rawDescription: null,
    extractionVersion: null,
    requirementEvidence: null,
    bulletProvenance: null,
  },
  {
    id: 'app-ramp',
    company: 'Ramp',
    roleTitle: 'Product Engineer',
    jobUrl: 'https://jobs.ashbyhq.com/ramp/9f21ab',
    createdAt: '2026-03-08T11:05:00.000Z',
    source: 'autofill',
    stage: 'phone_screen',
    jobInfo: {
      company: 'Ramp',
      team: 'Spend',
      roleTitle: 'Product Engineer',
      seniority: null,
      location: 'New York, NY',
      requirements: [
        { text: 'Shipped user-facing product', kind: 'unspecified', yearsOfExperience: null },
        { text: 'Strong product instincts', kind: 'preferred', yearsOfExperience: null },
      ],
      keywords: [
        { term: 'React', category: 'framework', postingSpelling: null },
        { term: 'product', category: 'domain', postingSpelling: null },
        { term: 'fintech', category: 'domain', postingSpelling: null },
      ],
    },
    tailoredResume: {
      skills: ['React', 'TypeScript', 'Product engineering'],
      workExperience: [
        {
          company: 'Halcyon',
          title: 'Engineer',
          startDate: '2019-06',
          endDate: '2021-12',
          bullets: [
            'Shipped the self-serve onboarding flow that took activation from 41% to 63%.',
            'Ran the weekly customer call rotation for the product team.',
          ],
        },
      ],
    },
    answers: [
      {
        fieldId: 'q-product',
        question: 'Tell us about a product decision you pushed for.',
        answer:
          'I argued for cutting the onboarding flow from six steps to three, against the worry that we would lose qualification data. Activation went from 41% to 63% and the data we lost turned out to be unused.',
        sourceStoryIds: ['onboarding-cut'],
      },
    ],
    notes: [
      {
        id: 'note-ramp-1',
        category: 'technical',
        text: 'Phone screen was a live CSS layout debug, not an algorithm question. Worth expecting again.',
        createdAt: '2026-03-12T15:45:00.000Z',
      },
    ],
    rawDescription: null,
    extractionVersion: null,
    requirementEvidence: null,
    bulletProvenance: null,
  },
  {
    id: 'app-notion',
    company: 'Notion',
    roleTitle: 'Frontend Engineer',
    jobUrl: 'https://jobs.ashbyhq.com/notion/7a3c19',
    createdAt: '2026-01-05T09:30:00.000Z',
    source: 'autofill',
    stage: 'offer',
    jobInfo: {
      company: 'Notion',
      team: 'Editor',
      roleTitle: 'Frontend Engineer',
      seniority: null,
      location: 'San Francisco, CA',
      requirements: [
        { text: 'Deep React experience', kind: 'required', yearsOfExperience: 4 },
        { text: 'Editor/canvas UI experience', kind: 'preferred', yearsOfExperience: null },
      ],
      keywords: [
        { term: 'React', category: 'framework', postingSpelling: null },
        { term: 'TypeScript', category: 'language', postingSpelling: null },
      ],
    },
    tailoredResume: {
      skills: ['React', 'TypeScript', 'Product engineering'],
      workExperience: [
        {
          company: 'Halcyon',
          title: 'Engineer',
          startDate: '2019-06',
          endDate: '2021-12',
          bullets: ['Built the block editor’s drag-and-drop reorder from scratch.'],
        },
      ],
    },
    answers: [
      {
        fieldId: 'q-editor',
        question: 'What draws you to editor/canvas UI work?',
        answer:
          'I built a drag-and-drop reorder system for a block editor and liked the precision it demands more than typical CRUD work.',
        sourceStoryIds: [],
      },
    ],
    notes: [
      {
        id: 'note-notion-1',
        category: 'general',
        text: 'Offer came in a week after the onsite. Comp call scheduled for Friday.',
        createdAt: '2026-01-12T16:00:00.000Z',
      },
    ],
    rawDescription: null,
    extractionVersion: null,
    requirementEvidence: null,
    bulletProvenance: null,
  },
  {
    id: 'app-vercel',
    company: 'Vercel',
    roleTitle: 'Software Engineer, Developer Experience',
    jobUrl: 'https://boards.greenhouse.io/vercel/jobs/5588',
    createdAt: '2026-02-27T08:20:00.000Z',
    source: 'autofill',
    stage: 'rejected',
    jobInfo: {
      company: 'Vercel',
      team: 'Developer Experience',
      roleTitle: 'Software Engineer, Developer Experience',
      seniority: null,
      location: 'Remote',
      requirements: [
        { text: 'Open-source contributions', kind: 'preferred', yearsOfExperience: null },
        { text: 'Next.js familiarity', kind: 'required', yearsOfExperience: null },
      ],
      keywords: [
        { term: 'Next.js', category: 'framework', postingSpelling: null },
        { term: 'DX', category: 'domain', postingSpelling: null },
        { term: 'open source', category: 'domain', postingSpelling: null },
      ],
    },
    tailoredResume: {
      skills: ['Next.js', 'TypeScript', 'Developer tooling'],
      workExperience: [
        {
          company: 'Northwind',
          title: 'Senior Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: ['Maintained the internal CLI used by every engineer in the company.'],
        },
      ],
    },
    answers: [
      {
        fieldId: 'q-oss',
        question: 'Link us to something you have built in the open.',
        answer:
          'The design-system codemod I published after the migration, which has since been used by two other companies.',
        sourceStoryIds: ['design-system-migration'],
      },
    ],
    notes: [
      {
        id: 'note-vercel-1',
        category: 'general',
        text: 'Rejected after the take-home. Feedback was that the solution was over-engineered for the brief.',
        createdAt: '2026-03-06T09:00:00.000Z',
      },
      {
        id: 'note-vercel-2',
        category: 'technical',
        text: 'Take-home was a file-watcher CLI, four hours nominal. Took closer to six.',
        createdAt: '2026-03-06T09:04:00.000Z',
      },
    ],
    rawDescription: null,
    extractionVersion: null,
    requirementEvidence: null,
    bulletProvenance: null,
  },
  {
    id: 'app-linear',
    company: 'Linear',
    roleTitle: 'Frontend Engineer',
    jobUrl: 'https://jobs.ashbyhq.com/linear/33cd91',
    createdAt: '2026-03-16T13:00:00.000Z',
    source: 'autofill',
    stage: 'applied',
    jobInfo: {
      company: 'Linear',
      team: null,
      roleTitle: 'Frontend Engineer',
      seniority: null,
      location: 'Remote (Europe)',
      requirements: [
        { text: 'An eye for interaction detail', kind: 'preferred', yearsOfExperience: null },
        { text: 'Performance-minded', kind: 'preferred', yearsOfExperience: null },
      ],
      keywords: [
        { term: 'React', category: 'framework', postingSpelling: null },
        { term: 'performance', category: 'domain', postingSpelling: null },
        { term: 'animation', category: 'domain', postingSpelling: null },
      ],
    },
    tailoredResume: {
      skills: ['React', 'TypeScript', 'Performance'],
      workExperience: [
        {
          company: 'Northwind',
          title: 'Senior Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: ['Cut first-contentful-paint on the marketing site from 3.1s to 1.2s.'],
        },
      ],
    },
    answers: [
      {
        fieldId: 'q-craft',
        question: 'What does craft mean to you in frontend work?',
        answer:
          'Mostly it means the states nobody asks about: what the empty list looks like, what happens on a slow connection, where focus goes after a dialog closes.',
        sourceStoryIds: [],
      },
    ],
    notes: [],
    rawDescription: null,
    extractionVersion: null,
    requirementEvidence: null,
    bulletProvenance: null,
  },
  {
    id: 'app-stripe',
    company: 'Stripe',
    roleTitle:
      'Senior Software Engineer, Payments Infrastructure and Merchant Platform Reliability (EMEA)',
    jobUrl: 'https://stripe.com/jobs/listing/senior-software-engineer-payments/6612001',
    createdAt: '2026-01-19T07:30:00.000Z',
    source: 'autofill',
    stage: 'onsite',
    jobInfo: JobInfoSchema.parse({
      company: 'Stripe',
      team: 'Payments Infrastructure',
      roleTitle: 'Senior Software Engineer, Payments Infrastructure',
      seniority: 'Senior',
      location: 'Dublin, Ireland (Hybrid)',
      requirements: [
        'Experience operating high-throughput distributed systems',
        'Familiarity with payment rails or comparable regulated domains',
        'A track record of improving reliability of systems you did not originally build',
        'Comfort with on-call ownership and incident command',
      ],
      keywords: ['distributed systems', 'reliability', 'payments', 'Ruby', 'Go', 'observability'],
    }),
    tailoredResume: {
      skills: ['Go', 'Ruby', 'Distributed systems', 'Observability', 'Incident response', 'SQL'],
      workExperience: [
        {
          company: 'Northwind',
          title: 'Senior Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: [
            'Reduced p99 checkout latency from 2.4s to 480ms by moving fee calculation off the request path.',
            'Introduced structured logging and traces across eleven services, cutting mean time to diagnosis roughly in half.',
            'Ran incident command for the payments on-call rotation for eighteen months.',
            'Designed the idempotency layer that made retried charge submissions safe.',
            'Migrated the ledger from a single Postgres instance to a sharded topology with no downtime.',
            'Wrote the runbooks the team still uses for the three most common payment failures.',
          ],
        },
        {
          company: 'Halcyon',
          title: 'Engineer',
          startDate: '2019-06',
          endDate: '2021-12',
          bullets: [
            'Built the reconciliation job that caught a long-standing rounding discrepancy worth about £40k a year.',
            'Owned the webhook delivery system, including its retry and dead-letter behaviour.',
            'Added contract tests between the billing service and its four consumers.',
            'Cut the nightly batch window from six hours to ninety minutes.',
            'Mentored two junior engineers through their first on-call rotations.',
            'Replaced a hand-rolled queue with SQS, removing an entire class of duplicate-processing bug.',
          ],
        },
      ],
    },
    answers: [
      {
        fieldId: 'q-reliability',
        question:
          'Describe a system you inherited that was unreliable, and what you did about it. We are interested in the reasoning, not just the outcome.',
        answer:
          'The ledger I inherited had a nightly reconciliation that failed roughly twice a week, and the team had learned to just re-run it. I spent a week instrumenting it before changing anything, which showed the failures clustered around a specific merchant category with unusual refund timing. The fix was small — an ordering guarantee on refund application — but I would not have found it by reading the code, because the code was correct for every case anyone had thought to test.',
        sourceStoryIds: ['ledger-reconciliation'],
      },
      {
        fieldId: 'q-oncall',
        question: 'How do you think about on-call ownership?',
        answer:
          'The team that writes the service should carry the pager for it, because that is the only feedback loop that reliably prices operational shortcuts into design decisions.',
        sourceStoryIds: [],
      },
    ],
    notes: [
      {
        id: 'note-stripe-1',
        category: 'general',
        text: 'Four-stage loop: recruiter, technical phone screen, system design, then a values interview.',
        createdAt: '2026-01-24T12:00:00.000Z',
      },
      {
        id: 'note-stripe-2',
        category: 'technical',
        text: 'System design was "build a rate limiter for a multi-tenant API". Pushed hard on what happens when the limiter itself is down — wanted fail-open reasoning with a justification.',
        createdAt: '2026-02-11T16:20:00.000Z',
      },
      {
        id: 'note-stripe-3',
        category: 'behavioral',
        text: 'Values interview asked twice about disagreement. Have a second example ready that is not the design-system one.',
        createdAt: '2026-02-25T11:15:00.000Z',
      },
    ],
    rawDescription: null,
    extractionVersion: null,
    requirementEvidence: null,
    bulletProvenance: null,
  },
];

export const fixtureProfile: Profile = {
  fullName: 'Jordan Rivera',
  email: 'jordan.rivera@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [
    {
      company: 'Northwind',
      title: 'Senior Engineer',
      startDate: '2022-01',
      endDate: null,
      bullets: [
        'Led the migration of a 400-component design system to CSS custom properties, cutting bundle size 18%.',
        'Reduced p99 checkout latency from 2.4s to 480ms by moving fee calculation off the request path.',
      ],
      maxBullets: null,
      starredIndices: [],
      suppressIfEmpty: false,
    },
  ],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  projects: [],
  certifications: [],
  awards: [],
  skills: ['TypeScript', 'React', 'Node.js', 'GraphQL', 'Go', 'SQL'],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

/**
 * `extractResume`'s default fixture answer — a plausible draft with a couple of fields the
 * fixture Profile above doesn't have (a summary, a project), so a test can tell "the extraction
 * populated this" apart from "the seeded Profile already had it."
 */
export const fixtureExtractedProfile: ExtractedProfile = {
  fullName: 'Jordan Rivera',
  email: 'jordan.rivera@example.com',
  phone: '555-0100',
  location: 'Remote',
  links: { linkedin: 'https://linkedin.com/in/jordanrivera', portfolio: null, github: null },
  summary: 'Senior engineer focused on performance and design systems.',
  workExperience: [
    {
      company: 'Northwind',
      title: 'Senior Engineer',
      startDate: '2022-01',
      endDate: null,
      bullets: ['Led the migration of a 400-component design system to CSS custom properties.'],
    },
  ],
  education: [],
  skills: ['TypeScript', 'React'],
  projects: [
    {
      name: 'djobi',
      description: 'AI-tailored job application autofill',
      bullets: ['Built the resume-extraction pipeline'],
      link: null,
      technologies: ['TypeScript'],
    },
  ],
  certifications: [],
  awards: [],
};
