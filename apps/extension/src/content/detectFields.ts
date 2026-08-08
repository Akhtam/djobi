import type { DetectedField, FieldCategory } from '@djobi/shared';

/** Field elements that carry data a candidate fills in, as opposed to buttons/hidden inputs. */
type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Signal text used to classify a field: its `<label for>` text, or attribute fallbacks. */
function getSignal(doc: Document, el: FieldElement): string {
  const id = el.getAttribute('id');
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  return (
    el.getAttribute('aria-label') ??
    el.getAttribute('placeholder') ??
    el.getAttribute('name') ??
    id ??
    ''
  );
}

const KEYWORD_RULES: Array<[FieldCategory, RegExp]> = [
  ['email', /e-?mail/i],
  ['linkedin_url', /linkedin/i],
  ['github_url', /git ?hub/i],
  ['portfolio_url', /portfolio|website/i],
  ['first_name', /first name|given name/i],
  ['last_name', /last name|surname|family name/i],
  ['full_name', /full name/i],
  ['phone', /phone|mobile/i],
  ['location', /location|city|address/i],
  ['cover_letter_text', /cover letter/i],
];

const FILE_KEYWORD_RULES: Array<[FieldCategory, RegExp]> = [
  ['cover_letter_upload', /cover letter/i],
  ['resume_upload', /re[sz]ume|\bcv\b/i],
];

/** A `?`, or an imperative/question-style opener, marks an unmatched textarea as a free-response question. */
const QUESTION_SHAPE = /\?|^(why|how|what|describe|tell us|explain)\b/i;

/** Classifies a field by keyword-matching its signal text against a fixed category list. */
function classify(signal: string, inputType: string): FieldCategory {
  if (inputType === 'file') {
    const match = FILE_KEYWORD_RULES.find(([, pattern]) => pattern.test(signal));
    return match?.[0] ?? 'resume_upload';
  }

  const match = KEYWORD_RULES.find(([, pattern]) => pattern.test(signal));
  if (match) return match[0];

  if (inputType === 'textarea' && QUESTION_SHAPE.test(signal)) return 'question';

  return 'unknown';
}

/**
 * Finds every candidate-fillable field on the page and classifies it into a {@link DetectedField},
 * using each field's `<label for>` text (or aria-label/placeholder/name/id fallback) as the
 * classification signal. See `docs/architecture-plan.md`'s "Generic field detection" section.
 */
const NON_DATA_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

export function detectFields(doc: Document): DetectedField[] {
  const elements = Array.from(doc.querySelectorAll('input, textarea, select')) as FieldElement[];
  const dataElements = elements.filter(
    (el) => !NON_DATA_INPUT_TYPES.has((el as HTMLInputElement).type),
  );

  return dataElements.map((el, index) => {
    const signal = getSignal(doc, el);
    const id = el.id || `djobi-field-${index}`;

    if (!el.id) {
      el.setAttribute('data-djobi-id', id);
    }

    const inputType = (el as HTMLInputElement).type ?? el.tagName.toLowerCase();

    return {
      id,
      label: signal,
      inputType,
      selector: el.id ? `#${el.id}` : `[data-djobi-id="${id}"]`,
      category: classify(signal, inputType),
    };
  });
}
