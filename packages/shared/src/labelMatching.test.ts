import { describe, expect, it } from 'vitest';
import {
  containsLabel,
  labelsMatch,
  matchByContainment,
  matchByOverlap,
  matchOptionLabel,
  matchPreparedAnswerToOption,
  normalizeLabel,
  normalizeKeyword,
  questionsMatch,
  uniqueMatch,
} from './labelMatching.js';

describe('normalizeLabel', () => {
  it('ignores surrounding whitespace and case, the two ways the same label differs between a page and an ATS schema', () => {
    expect(normalizeLabel('  Yes ')).toBe('yes');
    expect(normalizeLabel('YES')).toBe('yes');
  });

  it('keeps everything else, including internal punctuation an option may need to stay distinct', () => {
    expect(normalizeLabel('San Francisco, CA')).toBe('san francisco, ca');
    expect(normalizeLabel('Yes - with a visa')).toBe('yes - with a visa');
  });
});

describe('normalizeKeyword', () => {
  it('treats case, whitespace and dash variants as the same keyword', () => {
    expect(normalizeKeyword(' Full-Stack ')).toBe('full stack');
    expect(normalizeKeyword('full\u2013stack')).toBe('full stack');
    expect(normalizeKeyword('full   stack')).toBe('full stack');
  });

  it('preserves punctuation that identifies a technology', () => {
    expect(normalizeKeyword('Next.js')).toBe('next.js');
    expect(normalizeKeyword('.NET')).toBe('.net');
    expect(normalizeKeyword('C++')).toBe('c++');
  });
});

describe('labelsMatch', () => {
  it('matches labels that differ only in case or surrounding whitespace', () => {
    expect(labelsMatch('Yes', ' yes ')).toBe(true);
  });

  it('does not match labels that differ in substance', () => {
    expect(labelsMatch('Yes', 'Yes, remotely')).toBe(false);
    expect(labelsMatch('No', 'Yes')).toBe(false);
  });
});

describe('matchOptionLabel', () => {
  it("returns the option's own spelling, so a case-only mismatch can be corrected to the text the page actually renders", () => {
    expect(matchOptionLabel(['Yes', 'No'], 'yes')).toBe('Yes');
  });

  it('returns undefined when the answer names no option, rather than force-fitting it to the nearest one', () => {
    expect(matchOptionLabel(['Yes', 'No'], 'Maybe')).toBeUndefined();
  });

  it('returns undefined when options collide once normalized', () => {
    expect(matchOptionLabel(['Remote', 'remote'], 'REMOTE')).toBeUndefined();
  });
});

describe('matchPreparedAnswerToOption', () => {
  it('does not let the exact-match stage bypass the ambiguity invariant', () => {
    expect(matchPreparedAnswerToOption(['Yes', ' yes '], 'YES')).toBeUndefined();
  });
});

/**
 * The ambiguity invariant, which every forgiving rule in this module defers to. It used to be
 * re-derived at each call site; these pin it in the one place it now lives.
 */
describe('uniqueMatch', () => {
  it('returns the sole candidate that satisfies the predicate', () => {
    expect(uniqueMatch(['a', 'bb', 'ccc'], (s) => s.length === 2)).toBe('bb');
  });

  it('returns undefined when several candidates match — the input does not say which was meant', () => {
    expect(uniqueMatch(['bb', 'cc'], (s) => s.length === 2)).toBeUndefined();
  });

  it('returns undefined when none match', () => {
    expect(uniqueMatch(['a', 'b'], (s) => s.length === 2)).toBeUndefined();
  });
});

describe('containsLabel', () => {
  it('finds a value inside a container that carries more than the value', () => {
    // A combobox trigger's textContent can hold a placeholder remnant or a clear-button label
    // alongside the selection, so reading it back needs containment, not equality.
    expect(containsLabel('Remote  ✕ Clear', 'remote')).toBe(true);
  });

  it('is false when the value is absent', () => {
    expect(containsLabel('Select an option', 'Remote')).toBe(false);
  });
});

describe('matchByContainment', () => {
  const stored = [
    { question: 'Are you willing to relocate?', answer: 'Yes' },
    { question: 'Do you have a work visa?', answer: 'No' },
  ];
  const questionOf = (entry: { question: string }) => entry.question;

  it("matches a form's longer phrasing against a shorter stored one, despite both ending in '?'", () => {
    // The regression this pins: with trailing punctuation kept, the stored question is not a
    // substring of the form's — the "?" lands mid-phrase — so this exact case, the one the feature
    // exists for, silently never matched.
    expect(
      matchByContainment(stored, questionOf, 'Are you willing to relocate for this role?'),
    ).toBe(stored[0]);
  });

  it('matches in the other direction too — neither side was written with the other in view', () => {
    expect(matchByContainment(stored, questionOf, 'relocate')).toBe(stored[0]);
  });

  it('returns undefined when two stored questions both look like the asked one', () => {
    const ambiguous = [
      { question: 'Are you authorized to work?', answer: 'Yes' },
      { question: 'Are you authorized to work in the US?', answer: 'Yes' },
    ];

    expect(
      matchByContainment(ambiguous, questionOf, 'Are you authorized to work in the US?'),
    ).toBeUndefined();
  });

  it('ignores a stored entry with a blank question rather than matching everything against it', () => {
    expect(matchByContainment([{ question: '   ', answer: 'x' }], questionOf, 'anything')).toBe(
      undefined,
    );
  });

  it('returns undefined for blank input', () => {
    expect(matchByContainment(stored, questionOf, '  ')).toBeUndefined();
  });
});

describe('questionsMatch', () => {
  it('matches the same question despite case and trailing punctuation', () => {
    expect(questionsMatch('How did you hear about us?', ' how did you hear about us. ')).toBe(true);
  });

  it('does not match a question with an added subject modifier', () => {
    expect(questionsMatch('Do you use React?', 'Do you use React Native?')).toBe(false);
  });
});

describe('matchByOverlap', () => {
  const questionOf = (stored: { question: string }) => stored.question;
  const stored = [
    {
      question: ' How are you currently using AI tools in your coding workflow?',
      answer: 'I use…',
    },
    { question: 'What country are you based in?', answer: 'USA' },
  ];

  it('matches a paraphrase of a stored question that shares no substring with it', () => {
    // The case this rule exists for. Every content word differs in form or scope — "use"/"using",
    // "work"/"coding workflow" — so containment sees two unrelated strings.
    expect(
      matchByOverlap(stored, questionOf, 'How do you currently use AI tools in your work?'),
    ).toBe(stored[0]);
  });

  it('ignores the scaffolding a question is phrased with, matching on its subject', () => {
    expect(matchByOverlap(stored, questionOf, 'What AI tools do you use currently?')).toBe(
      stored[0],
    );
  });

  it.each([
    // One shared content word each — "based", "tools", "use" — and a different subject.
    ['What state are you based in?'],
    ['Which of our tools have you used?'],
    ['Describe a time you used a tool to debug a production incident.'],
    ['Why do you want to work here?'],
  ])('declines %j, whose subject the stored questions do not share', (question) => {
    expect(matchByOverlap(stored, questionOf, question)).toBeUndefined();
  });

  it.each([
    [
      'How many years of experience do you have with Python?',
      'How many years of experience do you have with Java?',
    ],
    ['Why do you want to work at Acme?', 'Why do you want to work at Globex?'],
    ['Describe a time you led a team.', 'Describe a time you joined a team.'],
  ])('declines %j against %j, whose difference is the whole question', (storedQuestion, asked) => {
    // These score well over the threshold — the Python/Java pair shares three of five content
    // words — because what differs is a single word. That word is the subject, and filling the
    // stored answer in would submit a false statement in the candidate's name.
    const contrasted = [{ question: storedQuestion, answer: 'Eight years, mostly at Acme.' }];

    expect(matchByOverlap(contrasted, questionOf, asked)).toBeUndefined();
  });

  it.each([
    ['How many years have you used React?', 'How many years have you used React Native?'],
    ['Are you able to work in Portland?', 'Are you able to work in South Portland?'],
    [
      'Why are you interested in the Software Engineer role?',
      'Why are you interested in the Senior Software Engineer role?',
    ],
    ['How have you used Oracle?', 'How have you used Oracle Cloud?'],
    ['How many years have you used Java?', 'How many years have you used JavaScript?'],
  ])('declines additive subject change %j against %j', (storedQuestion, asked) => {
    const qualified = [{ question: storedQuestion, answer: 'Prepared for the narrower question.' }];

    expect(matchByOverlap(qualified, questionOf, asked)).toBeUndefined();
  });

  it('declines a question that shares its only content word with a stored one', () => {
    // A single word in common is a coincidence at any ratio: this scores 1.0 against
    // "What country are you based in?" on "country" alone.
    expect(matchByOverlap(stored, questionOf, 'Country?')).toBeUndefined();
  });

  it('declines when two stored questions are equally about the asked one', () => {
    const ambiguous = [
      { question: 'How do you use AI tools at work?', answer: 'One way' },
      { question: 'How are you using AI tools in your work?', answer: 'Another way' },
    ];

    expect(
      matchByOverlap(ambiguous, questionOf, 'How do you use AI tools in your work?'),
    ).toBeUndefined();
  });

  it('returns undefined for a question that is nothing but scaffolding', () => {
    expect(matchByOverlap(stored, questionOf, 'What about you?')).toBeUndefined();
  });
});
