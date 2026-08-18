/**
 * Applications for the test suite. **Not shipped** — nothing under `main.tsx` imports this, and the
 * running app always talks to the real backend.
 *
 * Typed as `Application[]` rather than left inferred on purpose: these stand in for rows the
 * backend produces, so a change to `ApplicationSchema` must break this file's build rather than
 * quietly leave the UI developed against a shape that no longer exists.
 *
 * The set is chosen to cover every branch the UI has, not to look plausible:
 * one row per `ApplicationStage`, an empty notes log, a log with all three note categories, an
 * application with no drafted answers, and one deliberately oversized row (long role title, twelve
 * resume bullets, long answers) to stress the layout.
 */
import type { Application } from '@djobi/shared';

export const fixtureApplications: Application[] = [
  {
    id: 'app-brex',
    company: 'Brex',
    roleTitle: 'Senior Frontend Engineer',
    jobUrl: 'https://boards.greenhouse.io/brex/jobs/4012',
    createdAt: '2026-03-14T09:12:00.000Z',
    stage: 'interviewing',
    jobInfo: {
      company: 'Brex',
      team: 'Infrastructure',
      roleTitle: 'Senior Frontend Engineer',
      seniority: 'Senior',
      location: 'Remote (US)',
      requirements: [
        '5+ years building production React applications',
        'Experience with design systems at scale',
        'Comfort owning a service end to end',
      ],
      keywords: ['React', 'TypeScript', 'design systems', 'GraphQL'],
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
  },
  {
    id: 'app-sonar',
    company: 'Sonar',
    roleTitle: 'Staff Engineer, Platform',
    jobUrl: 'https://jobs.lever.co/sonarsource/8a1f2c33/apply',
    createdAt: '2026-03-11T16:40:00.000Z',
    stage: 'applied',
    jobInfo: {
      company: 'Sonar',
      team: null,
      roleTitle: 'Staff Engineer, Platform',
      seniority: 'Staff',
      location: 'Geneva, Switzerland',
      requirements: ['Deep JVM experience', 'Static analysis background a plus'],
      keywords: ['Java', 'static analysis', 'platform'],
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
  },
  {
    id: 'app-ramp',
    company: 'Ramp',
    roleTitle: 'Product Engineer',
    jobUrl: 'https://jobs.ashbyhq.com/ramp/9f21ab',
    createdAt: '2026-03-08T11:05:00.000Z',
    stage: 'phone_screen',
    jobInfo: {
      company: 'Ramp',
      team: 'Spend',
      roleTitle: 'Product Engineer',
      seniority: null,
      location: 'New York, NY',
      requirements: ['Shipped user-facing product', 'Strong product instincts'],
      keywords: ['React', 'product', 'fintech'],
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
  },
  {
    id: 'app-vercel',
    company: 'Vercel',
    roleTitle: 'Software Engineer, Developer Experience',
    jobUrl: 'https://boards.greenhouse.io/vercel/jobs/5588',
    createdAt: '2026-02-27T08:20:00.000Z',
    stage: 'rejected',
    jobInfo: {
      company: 'Vercel',
      team: 'Developer Experience',
      roleTitle: 'Software Engineer, Developer Experience',
      seniority: null,
      location: 'Remote',
      requirements: ['Open-source contributions', 'Next.js familiarity'],
      keywords: ['Next.js', 'DX', 'open source'],
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
  },
  {
    id: 'app-linear',
    company: 'Linear',
    roleTitle: 'Frontend Engineer',
    jobUrl: 'https://jobs.ashbyhq.com/linear/33cd91',
    createdAt: '2026-03-16T13:00:00.000Z',
    stage: 'applied',
    jobInfo: {
      company: 'Linear',
      team: null,
      roleTitle: 'Frontend Engineer',
      seniority: null,
      location: 'Remote (Europe)',
      requirements: ['An eye for interaction detail', 'Performance-minded'],
      keywords: ['React', 'performance', 'animation'],
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
  },
  {
    id: 'app-stripe',
    company: 'Stripe',
    roleTitle:
      'Senior Software Engineer, Payments Infrastructure and Merchant Platform Reliability (EMEA)',
    jobUrl: 'https://stripe.com/jobs/listing/senior-software-engineer-payments/6612001',
    createdAt: '2026-01-19T07:30:00.000Z',
    stage: 'interviewing',
    jobInfo: {
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
    },
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
  },
];
