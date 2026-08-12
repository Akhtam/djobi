/**
 * Prepared answers: the facts about a candidate that an application asks for over and over, stored
 * once on the profile so nothing has to infer them per application.
 *
 * Work authorization, sponsorship, veteran status and the rest are matters of fact with exactly one
 * correct answer, and that answer is the same on every form. Drafting them from a language model is
 * both wasted work and the one place a wrong answer really costs something — a guessed "yes" to a
 * sponsorship question is a misrepresentation on a legal document. So a question that matches a
 * known topic is answered from the profile and never reaches the model at all.
 *
 * Matching is by regular expression against the question's own label, in the order listed below.
 * Order is load-bearing where topics overlap: "Are you authorized to work in the US without
 * sponsorship?" mentions both, and reads as a work-authorization question, so that topic is tried
 * first.
 */
import { z } from 'zod';

/**
 * The known topics, each with the pattern that recognizes it and the label the options UI shows.
 * This object is the single source of truth: the topic enum, the matcher order and the editor's
 * rows are all derived from it, so a new topic is added here and nowhere else.
 *
 * `suggestions` are offered in the editor as one-click values. They're a convenience, not a
 * constraint — any of these fields can hold whatever text the candidate wants.
 */
export const SCREENING_TOPICS = [
  {
    topic: 'work_authorization',
    label: 'Are you legally authorized to work in this country?',
    pattern:
      /legally authoriz|authoriz(ed|ation) to work|work authorization|(eligible|right) to work/i,
    suggestions: ['Yes', 'No'],
  },
  {
    topic: 'sponsorship_required',
    label: 'Will you now or in the future require visa sponsorship?',
    pattern: /sponsor/i,
    suggestions: ['No', 'Yes'],
  },
  {
    topic: 'relocation',
    label: 'Are you willing to relocate?',
    pattern: /relocat/i,
    suggestions: ['Yes', 'No'],
  },
  {
    topic: 'remote_onsite',
    label: 'Are you willing to work onsite / hybrid?',
    pattern: /willing to work (onsite|on-site|in.the.office|hybrid)|commute/i,
    suggestions: ['Yes', 'No'],
  },
  {
    topic: 'notice_period',
    label: 'What is your notice period?',
    pattern: /notice period/i,
    suggestions: ['2 weeks', '1 month', 'None — available immediately'],
  },
  {
    topic: 'start_date',
    label: 'When can you start?',
    pattern:
      /start date|when (can|could) you start|earliest.*(start|availab)|availability to start/i,
    suggestions: ['Immediately', '2 weeks from offer'],
  },
  {
    topic: 'salary_expectation',
    label: 'What are your salary expectations?',
    pattern: /salary|(compensation|pay) expectation|(expected|desired) (salary|compensation|pay)/i,
    suggestions: ['Negotiable', 'Open to discussion'],
  },
  {
    topic: 'age_over_18',
    label: 'Are you at least 18 years old?',
    pattern: /(at least|over|older than) 18|18 years or older/i,
    suggestions: ['Yes'],
  },
  {
    topic: 'criminal_record',
    label: 'Have you ever been convicted of a crime?',
    pattern: /convicted|criminal (record|history|conviction)|felony/i,
    suggestions: ['No', 'Yes'],
  },
  {
    topic: 'non_compete',
    label: 'Are you bound by a non-compete or other restrictive agreement?',
    pattern: /non-?compete|restrictive covenant/i,
    suggestions: ['No', 'Yes'],
  },
  {
    topic: 'previously_employed',
    label: 'Have you previously worked for this company?',
    pattern:
      /previously (worked|been employed)|former employee|ever (worked|been employed) (for|at) (us|this company)/i,
    suggestions: ['No', 'Yes'],
  },
  {
    topic: 'referral_source',
    label: 'How did you hear about this role?',
    pattern: /how did you (hear|find out)|referral source|where did you (hear|find)/i,
    suggestions: ['LinkedIn', 'Company website', 'Referral'],
  },
  // The EEO/demographic block. Declining is a real, always-available answer and the safest default
  // — these are voluntary by law, so leaving them blank is not the same as answering them wrong.
  {
    topic: 'hispanic_latino',
    label: 'Are you Hispanic or Latino?',
    pattern: /hispanic|latino|latinx/i,
    suggestions: ['Decline to self-identify', 'No', 'Yes'],
  },
  {
    topic: 'race_ethnicity',
    label: 'Race / ethnicity',
    pattern: /\brace\b|ethnic/i,
    suggestions: ['Decline to self-identify'],
  },
  {
    topic: 'gender',
    label: 'Gender',
    pattern: /\bgender\b|\bsex\b/i,
    suggestions: ['Decline to self-identify'],
  },
  {
    topic: 'veteran_status',
    label: 'Veteran status',
    pattern: /veteran/i,
    suggestions: ['I am not a protected veteran', 'Decline to self-identify'],
  },
  {
    topic: 'disability_status',
    label: 'Disability status',
    pattern: /disab/i,
    suggestions: ['No, I do not have a disability', 'Decline to self-identify'],
  },
] as const;

export type ScreeningTopic = (typeof SCREENING_TOPICS)[number]['topic'];

const TOPIC_NAMES = SCREENING_TOPICS.map((entry) => entry.topic) as [
  ScreeningTopic,
  ...ScreeningTopic[],
];

export const ScreeningTopicSchema = z.enum(TOPIC_NAMES);

/** Stored answers, keyed by topic. A topic with no entry simply hasn't been answered. */
export const ScreeningAnswersSchema = z.record(ScreeningTopicSchema, z.string());
export type ScreeningAnswers = z.infer<typeof ScreeningAnswersSchema>;

/** One prepared answer to a question the fixed topics don't cover. */
export const CustomAnswerSchema = z.object({
  question: z.string().describe('The question as it tends to appear on forms'),
  answer: z.string(),
});
export type CustomAnswer = z.infer<typeof CustomAnswerSchema>;

/** The topic `question` is asking about, or `undefined` if it isn't one of the known ones. */
export function matchScreeningTopic(question: string): ScreeningTopic | undefined {
  return SCREENING_TOPICS.find((entry) => entry.pattern.test(question))?.topic;
}
