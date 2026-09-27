/**
 * Real-posting evaluation: runs `extractJob` and `tailorResume` on a fixed set of realistic,
 * hand-written postings and one sample Profile, then reports `requirementEvidence`,
 * `bulletProvenance` and Importance Gate behavior for eyeballing live model output.
 *
 * A developer tool — live calls cost money and aren't deterministic, so it's not in CI. Run with
 * `pnpm --filter backend eval:extraction`. Add postings to `POSTINGS` as new cases turn up.
 */
import 'dotenv/config';
import {
  bulletProvenance,
  DECISIVE_BANDS,
  normalizeQuote,
  quoteHolds,
  requirementEvidence,
  type Profile,
} from '@djobi/shared';
import { extractJob } from '../src/llm/extractJob.js';
import { tailorResume } from '../src/llm/tailorResume.js';

const SAMPLE_PROFILE: Profile = {
  fullName: 'Jordan Rivera',
  email: 'jordan.rivera@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [
    {
      company: 'Northwind',
      title: 'Senior Backend Engineer',
      startDate: '2020-03',
      endDate: null,
      bullets: [
        'Led the migration of the billing service from a monolith to a set of Go microservices deployed on Kubernetes.',
        'Reduced p99 checkout latency from 1.8s to 400ms by moving fee calculation off the request path and adding Redis caching.',
        'Owned the on-call rotation for the payments team for two years, including incident command.',
        'Designed the idempotency layer that made retried charge submissions safe.',
        'Mentored three junior engineers through their first on-call rotations.',
      ],
      maxBullets: 6,
      starredIndices: [],
      suppressIfEmpty: false,
    },
    {
      company: 'Halcyon',
      title: 'Software Engineer',
      startDate: '2017-06',
      endDate: '2020-02',
      bullets: [
        'Built the reconciliation job that caught a long-standing rounding discrepancy worth roughly $40k a year.',
        'Wrote the internal CLI the team still uses to replay failed webhook deliveries.',
        'Migrated the primary datastore from MySQL to PostgreSQL with no downtime.',
      ],
      maxBullets: 6,
      starredIndices: [],
      suppressIfEmpty: false,
    },
  ],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  skills: ['Go', 'PostgreSQL', 'Kubernetes', 'Redis', 'TypeScript'],
  projects: [],
  certifications: [],
  awards: [],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

const POSTINGS: { label: string; text: string }[] = [
  {
    label: 'clear required/preferred split, one stated years figure',
    text: `Senior Backend Engineer — Payments Infrastructure
Acme Corp · Remote (US)

We're looking for a senior backend engineer to help scale our payments platform.

Requirements
- 5+ years of experience building backend systems in Go, Java, or a comparable language
- Experience operating services on Kubernetes in production
- Comfort owning an on-call rotation

Nice to have
- Experience with PostgreSQL at scale
- Familiarity with idempotent payment processing
- Prior fintech or regulated-industry experience`,
  },
  {
    label: 'no explicit required/preferred headings',
    text: `Backend Engineer, Platform Team
Globex — Hybrid (Berlin)

Globex is hiring a backend engineer for our platform team. You'll work on the services that every
other team at Globex builds on top of, including our internal deployment tooling and our shared
caching layer.

We use Go and TypeScript day to day, run everything on Kubernetes, and lean heavily on PostgreSQL
and Redis. You should be comfortable reading unfamiliar code, writing tests for it, and shipping
incrementally rather than in big-bang rewrites. Some exposure to distributed systems concepts —
consistency, idempotency, retries — will help you ramp up faster.`,
  },
  {
    label: 'multiple stated years figures across different requirements',
    text: `Staff Software Engineer — Checkout
Initech · Remote (EMEA)

Requirements
- 8+ years of professional software engineering experience
- 3+ years specifically working on payments or checkout systems
- Deep experience with PostgreSQL, including schema migrations at scale
- Track record of mentoring engineers and reviewing their work

Nice to have
- Experience with Kubernetes
- Open-source contributions`,
  },
  {
    // No must-have wording or headings, so any `critical`/`high` band here means the gate leaked.
    label: 'no must-have wording at all — exercises the inferred cap',
    text: `Engineer, Growth
Umbrella · Remote

We are a small team building tools people use every day. Day to day you might be tuning a slow
query, sketching an experiment with a designer, or working out why a funnel dropped overnight. We
work in TypeScript, deploy several times a day, and talk to customers ourselves.

You will probably enjoy this if you like owning something end to end and are comfortable when the
problem is not yet well defined. We care much more about how you think than about which frameworks
you have used before.`,
  },
];

function printJson(label: string, value: unknown): void {
  console.log(`  ${label}:`);
  console.log(
    JSON.stringify(value, null, 2)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  );
}

async function evaluatePosting(posting: { label: string; text: string }): Promise<void> {
  console.log(`\n${'='.repeat(80)}\n${posting.label}\n${'='.repeat(80)}`);

  const jobInfo = await extractJob(posting.text);
  printJson('extracted keywords', jobInfo.keywords);
  printJson('extracted requirements', jobInfo.requirements);

  const tailoredResume = await tailorResume(SAMPLE_PROFILE, jobInfo);

  // Re-runs the quote check `extractJob` already applied; any line printed means the gate failed.
  const normalizedPosting = normalizeQuote(posting.text);
  const laundered = jobInfo.requirements.filter(
    (requirement) =>
      requirement.importanceTier === 'stated' &&
      !quoteHolds(requirement.postingSignal, normalizedPosting),
  );
  if (laundered.length > 0) {
    console.log(`\n  ✗ ${laundered.length} stated band(s) whose quote is not in the posting`);
  }

  const evidence = requirementEvidence(tailoredResume, jobInfo, SAMPLE_PROFILE);
  console.log('\n  requirement evidence (most decisive first):');
  for (const entry of evidence) {
    const band = entry.requirement.importance ?? 'unbanded';
    const tier = entry.requirement.importanceTier ?? '—';
    console.log(
      `    [${band}/${tier}]`.padEnd(28) + `${entry.verdict.padEnd(24)} ${entry.requirement.text}`,
    );
  }

  // Flag by band, not `kind`: only decisive bands are vouched for by the gate.
  const flaggedDecisive = evidence.filter(
    (entry) =>
      entry.requirement.importance !== null &&
      DECISIVE_BANDS.has(entry.requirement.importance) &&
      (entry.verdict === 'unsupported' || entry.verdict === 'needs-confirmation'),
  );
  if (flaggedDecisive.length > 0) {
    console.log(`  ⚠ ${flaggedDecisive.length} decisive item(s) unsupported or unconfirmed`);
  }

  const provenance = bulletProvenance(tailoredResume, SAMPLE_PROFILE);
  console.log('\n  bullet provenance:');
  for (const entry of provenance) {
    console.log(`    [${entry.verdict}] ${entry.bullet}`);
    if (entry.verdict === 'reworded') console.log(`      from: ${entry.source}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      'OPENROUTER_API_KEY is not set — this script makes real model calls and needs it. ' +
        'Copy .env.example to .env and fill it in.',
    );
    process.exitCode = 1;
    return;
  }

  for (const posting of POSTINGS) {
    await evaluatePosting(posting);
  }
}

await main();
