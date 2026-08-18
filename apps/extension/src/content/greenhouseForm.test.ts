/**
 * Detection and enrichment against a **real, unmodified Greenhouse posting**, captured live.
 *
 * `__fixtures__/brex-greenhouse.html` is the server-rendered markup of
 * `boards.greenhouse.io/embed/job_app?for=brex&token=8459783002`, and
 * `__fixtures__/brex-greenhouse-api.json` is what the Greenhouse Job Board API answers for that same
 * posting. Both were fetched, not written — which is the point of this file. Every case below is a
 * defect the hand-written fixtures in `detectFields.test.ts` could not have caught, because each one
 * comes from markup nobody would think to invent: two file inputs sharing one visually-hidden
 * "Attach" label, screening questions that mention "location" in prose, free-response questions
 * rendered as `<input type="text">`, and required labels carrying an asterisk the API's wording
 * doesn't have.
 *
 * The posting is reachable at three URLs — the Greenhouse-hosted path, the embed iframe, and Brex's
 * own white-labeled `www.brex.com/careers/…?gh_jid=…` — and the last two are covered here because
 * the oracle recognized neither.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { detectFields } from './detectFields';
import { fillForm } from './fillForm';
import { enrichWithApiOracle } from '../background/apiDetectors';
import type { DetectedField } from '@djobi/shared';

/** Brex's own careers domain — the shape that carries the posting id as `gh_jid` and no board token. */
const WHITE_LABEL_URL =
  'https://www.brex.com/careers/8459783002?gh_jid=8459783002&gh_src=m751li9j2us';

/**
 * Resolved against this file, not the working directory, so the suite runs from anywhere.
 *
 * `import.meta.dirname` rather than `new URL('./…', import.meta.url)`: under the jsdom environment
 * the global `URL` is jsdom's, and it resolves a relative reference against the *document's* base
 * (`http://localhost:3000/`) instead of the `file://` base handed to it — so the second form yields
 * an http URL and `readFileSync` rejects it.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8');
}

/**
 * The fixture's `<body>` loaded into this test's own document, rather than into a fresh `JSDOM`.
 *
 * Not incidental: `detectFields` resolves every DOM-class test through `ownerDocument.defaultView`,
 * and a document with no browsing context (a `DOMParser` one, say) has none — so it would report no
 * required flags, no select options and every choice group as a radiogroup, and this file would be
 * testing the wrong thing while looking like it passed.
 */
function detect(): DetectedField[] {
  document.body.innerHTML = fixture('brex-greenhouse.html').replace(
    /^[\s\S]*?<body[^>]*>|<\/body>[\s\S]*$/g,
    '',
  );
  return detectFields(document);
}

/** The one field whose label contains `needle`; throws rather than silently asserting on nothing. */
function find(fields: DetectedField[], needle: string): DetectedField {
  const matches = fields.filter((field) =>
    field.label.toLowerCase().includes(needle.toLowerCase()),
  );
  if (matches.length !== 1) {
    throw new Error(`${matches.length} fields' labels contain ${JSON.stringify(needle)}, wanted 1`);
  }
  return matches[0];
}

/** Every URL the oracle asked for during the current test. */
let requestedUrls: string[] = [];

beforeEach(() => {
  requestedUrls = [];
});

/** The oracle, answering with this posting's real API response instead of hitting the network. */
function stubbedFetch(): typeof fetch {
  const body = fixture('brex-greenhouse-api.json');
  return (async (url: string) => {
    requestedUrls.push(url);
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("a live Greenhouse posting's application form", () => {
  it('classifies screening questions that merely mention a location as questions', () => {
    const fields = detect();

    // All three were `location`, so the Fill Step pasted the candidate's city into a Yes/No choice.
    expect(find(fields, 'Are you authorized to work in the stated location').category).toBe(
      'question',
    );
    expect(find(fields, 'plan to relocate to, the specified location').category).toBe('question');
    expect(find(fields, 'what sponsorship would you require').category).toBe('question');

    // …while a field that really does ask where the candidate is stays a profile field.
    expect(find(fields, 'Location (City)').category).toBe('location');
  });

  it('tells the resume and cover-letter uploads apart despite their identical "Attach" labels', () => {
    const files = detect().filter((field) => field.inputType === 'file');

    expect(files.map((field) => field.label)).toEqual(['Resume/CV', 'Cover Letter']);
    expect(files.map((field) => field.category)).toEqual(['resume_upload', 'cover_letter_upload']);
  });

  it('classifies free-response questions rendered as text inputs', () => {
    const fields = detect();

    expect(find(fields, 'preferred gender pronouns').category).toBe('question');
    expect(find(fields, "state the Brex employee's name").category).toBe('question');
    // Required, and previously `unknown` — so it was never drafted and the form could not be
    // completed without the candidate noticing the gap themselves.
    expect(find(fields, 'worked, at Capital One').category).toBe('question');
  });

  it('reports labels without the required marker, so the API can be matched against them', () => {
    const fields = detect();

    expect(find(fields, 'First Name').label).toBe('First Name');
    expect(find(fields, 'First Name').required).toBe(true);
    expect(find(fields, 'How did you hear about us').label).toBe('How did you hear about us?');
  });

  it.each([
    ['white-labeled', WHITE_LABEL_URL],
    ['Greenhouse-hosted', 'https://job-boards.greenhouse.io/brex/jobs/8459783002'],
    ['embed iframe', 'https://boards.greenhouse.io/embed/job_app?for=brex&token=8459783002'],
  ])('enriches portal-mounted comboboxes with API choices from a %s URL', async (_name, url) => {
    const enriched = await enrichWithApiOracle(url, detect(), stubbedFetch());

    // Greenhouse mounts its option lists in a portal, so the DOM scan finds no choices at all —
    // these questions are unanswerable without the API's.
    expect(find(detect(), 'How did you hear about us').options).toBeUndefined();
    expect(find(enriched, 'How did you hear about us').options).toHaveLength(11);
    expect(
      find(enriched, 'Are you authorized to work in the stated location').options,
    ).toHaveLength(2);
  });

  it.each([
    // A company's own numeric route must not be mistaken for the posting id `gh_jid` states.
    [
      'a site-local numeric route',
      'https://careers.acme.com/en/jobs/482?gh_jid=8459783002',
      'acme',
    ],
    // A subdomain that names the page rather than the company.
    ['a role-naming subdomain', 'https://join.brex.com/roles/1?gh_jid=8459783002', 'brex'],
  ])('resolves the board and posting id from %s', async (_name, url, board) => {
    const enriched = await enrichWithApiOracle(url, detect(), stubbedFetch());

    expect(find(enriched, 'How did you hear about us').options).toHaveLength(11);
    // The stub answers whatever is asked, so a misread board or id only shows up in the request.
    expect(requestedUrls).toEqual([
      `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/8459783002?questions=true`,
    ]);
  });

  it('never lets a URL parameter reshape the API request', async () => {
    await enrichWithApiOracle(
      'https://boards.greenhouse.io/embed/job_app?for=acme%2F..%2Fx&token=1%3Fadmin',
      detect(),
      stubbedFetch(),
    );

    // A non-numeric `token` is not a posting id at all, so nothing is requested.
    expect(requestedUrls).toEqual([]);
  });

  it('fills the form end to end, from detection through to the page holding the values', async () => {
    // The symptom this whole file exists for is "doesn't autofill", and every case above asserts a
    // *cause*. This one asserts the symptom: run the real pipeline over the real markup and read the
    // values back off the page, so a detection change that classifies beautifully but fills nothing
    // still fails here.
    const fields = await enrichWithApiOracle(WHITE_LABEL_URL, detect(), stubbedFetch());

    const answers: Record<string, string> = {
      [find(fields, 'First Name').id]: 'Ada',
      [find(fields, 'Last Name').id]: 'Lovelace',
      [find(fields, 'Email').id]: 'ada@example.com',
      [find(fields, 'LinkedIn Profile').id]: 'https://linkedin.com/in/ada',
      // A free-response screening question that used to classify `unknown`, so was never drafted.
      [find(fields, 'preferred gender pronouns').id]: 'She/Her',
    };

    // No combobox here: its listbox is portal-mounted and genuinely absent from this markup, so
    // filling one needs a live page. `optionWait*` is pinned low anyway to keep the test fast.
    const filled = await fillForm(document, fields, answers, {
      settleMs: 0,
      optionWaitAttempts: 1,
      optionWaitIntervalMs: 0,
    });

    expect(filled.sort()).toEqual(Object.keys(answers).sort());
    expect(document.querySelector<HTMLInputElement>('#first_name')?.value).toBe('Ada');
    expect(document.querySelector<HTMLInputElement>('#last_name')?.value).toBe('Lovelace');
    expect(document.querySelector<HTMLInputElement>('#email')?.value).toBe('ada@example.com');

    // And the API's choices reached the question that needs them, ready for the model to pick from.
    expect(find(fields, 'How did you hear about us').options).toHaveLength(11);
  });

  it('does not mistake a non-Greenhouse careers page for a board', async () => {
    const fields = detect();
    const untouched = await enrichWithApiOracle(
      'https://www.brex.com/careers/8459783002',
      fields,
      stubbedFetch(),
    );

    expect(untouched).toBe(fields);
  });
});
