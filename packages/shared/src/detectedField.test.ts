import { describe, expect, it } from 'vitest';
import {
  DetectedFieldSchema,
  FieldCategorySchema,
  matchAnswerToField,
  optionFor,
  parseDetectedFields,
  type DetectedField,
} from './detectedField.js';

describe('FieldCategorySchema', () => {
  it('accepts every documented category', () => {
    const categories = [
      'first_name',
      'last_name',
      'full_name',
      'email',
      'phone',
      'location',
      'linkedin_url',
      'portfolio_url',
      'github_url',
      'resume_upload',
      'cover_letter_upload',
      'cover_letter_text',
      'question',
      'unknown',
    ];
    for (const category of categories) {
      expect(FieldCategorySchema.safeParse(category).success).toBe(true);
    }
  });

  it('rejects an unrecognized category', () => {
    expect(FieldCategorySchema.safeParse('salary_expectation').success).toBe(false);
  });
});

describe('DetectedFieldSchema', () => {
  const validField = {
    id: 'field-1',
    label: 'Email address',
    inputType: 'input[type=email]',
    selector: '#email',
    category: 'email' as const,
  };

  it('accepts a valid detected field', () => {
    expect(DetectedFieldSchema.safeParse(validField).success).toBe(true);
  });

  it('rejects an invalid category', () => {
    expect(
      DetectedFieldSchema.safeParse({ ...validField, category: 'not_a_category' }).success,
    ).toBe(false);
  });

  it('defaults required to false and elementRole to native when omitted', () => {
    const result = DetectedFieldSchema.safeParse(validField);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.required).toBe(false);
      expect(result.data.elementRole).toBe('native');
      expect(result.data.options).toBeUndefined();
    }
  });

  it('accepts a required combobox field with options', () => {
    const result = DetectedFieldSchema.safeParse({
      ...validField,
      category: 'question',
      required: true,
      elementRole: 'combobox',
      options: [
        { label: 'Yes', selector: '#opt-yes' },
        { label: 'No', selector: '#opt-no' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toEqual([
        { label: 'Yes', selector: '#opt-yes' },
        { label: 'No', selector: '#opt-no' },
      ]);
    }
  });

  it("defaults an option's selector to null, for a choice known only from an ATS API schema", () => {
    const result = DetectedFieldSchema.safeParse({
      ...validField,
      elementRole: 'combobox',
      options: [{ label: 'Yes' }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toEqual([{ label: 'Yes', selector: null }]);
    }
  });

  it('rejects a bare string option, so label text can never be mistaken for a locatable choice', () => {
    expect(DetectedFieldSchema.safeParse({ ...validField, options: ['Yes', 'No'] }).success).toBe(
      false,
    );
  });

  it('rejects an invalid elementRole', () => {
    expect(DetectedFieldSchema.safeParse({ ...validField, elementRole: 'dropdown' }).success).toBe(
      false,
    );
  });
});

const field = (overrides: Partial<DetectedField> = {}): DetectedField => ({
  id: 'f1',
  label: 'Are you authorized to work in the US?',
  inputType: 'radiogroup',
  selector: '#f1',
  category: 'question',
  required: true,
  elementRole: 'radiogroup',
  ...overrides,
});

describe('parseDetectedFields', () => {
  it('applies schema defaults, so a field written before `required` and `elementRole` existed still parses', () => {
    const legacy = {
      id: 'f1',
      label: 'Email',
      inputType: 'email',
      selector: '#f1',
      category: 'email',
    };

    expect(parseDetectedFields([legacy])[0]).toMatchObject({
      required: false,
      elementRole: 'native',
    });
  });

  it('drops only the entries that no longer fit, so one stale field costs that field and not the form', () => {
    const good = field();

    const result = parseDetectedFields([
      good,
      { id: 'f2', category: 'not-a-category' },
      field({ id: 'f3' }),
    ]);

    expect(result.map((f) => f.id)).toEqual(['f1', 'f3']);
  });

  it('returns an empty list for a storage entry that is not an array at all', () => {
    expect(parseDetectedFields(undefined)).toEqual([]);
    expect(parseDetectedFields({ fields: [] })).toEqual([]);
  });
});

describe('optionFor', () => {
  const withOptions = field({
    options: [
      { label: 'Yes', selector: '#yes' },
      { label: 'No', selector: null },
    ],
  });

  it('finds the option the answer names, ignoring case and surrounding whitespace', () => {
    expect(optionFor(withOptions, ' yes ')).toEqual({ label: 'Yes', selector: '#yes' });
  });

  it('returns the option even when it has no selector, so the caller can fall back to label matching', () => {
    expect(optionFor(withOptions, 'No')?.selector).toBeNull();
  });

  it('returns undefined when the answer names no option, rather than the nearest one', () => {
    expect(optionFor(withOptions, 'Maybe')).toBeUndefined();
  });

  it('returns undefined for a field with no options at all', () => {
    expect(optionFor(field(), 'Yes')).toBeUndefined();
  });
});

describe('matchAnswerToField', () => {
  const answers = [
    { fieldId: 'f1', answer: 'Yes' },
    { fieldId: 'f2', answer: 'Remote' },
  ];

  it('matches by field id, the normal path', () => {
    expect(matchAnswerToField(field(), answers, new Map())).toBe('Yes');
  });

  it('falls back to the question text when the ATS re-mounted the element and gave it a new id', () => {
    const remounted = field({ id: 'f9' });
    const labels = new Map([['f1', 'Are you authorized to work in the US?']]);

    expect(matchAnswerToField(remounted, answers, labels)).toBe('Yes');
  });

  it('treats a label shared by several fields as no match, rather than filling one at random', () => {
    // Ashby renders "Start typing…" as the label of every combobox on a form.
    const remounted = field({ id: 'f9', label: 'Start typing…' });
    const labels = new Map([
      ['f1', 'Start typing…'],
      ['f2', 'Start typing…'],
    ]);

    expect(matchAnswerToField(remounted, answers, labels)).toBeUndefined();
  });

  it('returns undefined for a field with no label to match on', () => {
    expect(matchAnswerToField(field({ id: 'f9', label: '' }), answers, new Map())).toBeUndefined();
  });
});
