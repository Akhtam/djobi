import type { DetectedField } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { carryEnrichment, enrichWithApiOracle } from './apiDetectors';

/**
 * Every test drives the one exported function with a stubbed `fetch`. The per-platform URL parsers
 * and merge helpers used to be exported purely so tests could reach them; asserting on the endpoint
 * a URL produces and the fields a response yields covers the same ground through the interface the
 * background actually calls.
 */

function field(overrides: Partial<DetectedField>): DetectedField {
  return {
    id: 'f1',
    label: 'Email',
    inputType: 'text',
    selector: '#f1',
    category: 'email',
    required: false,
    elementRole: 'native',
    ...overrides,
  };
}

const question = (label: string, overrides: Partial<DetectedField> = {}) =>
  field({ id: 'q1', label, category: 'question', elementRole: 'combobox', ...overrides });

function stubFetch(body: unknown, init: { ok?: boolean } = {}) {
  return vi.fn().mockResolvedValue({ ok: init.ok ?? true, json: async () => body });
}

describe('enrichWithApiOracle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Silenced by default so a diagnostic warning doesn't clutter the run; the tests that care
    // about one read it back off this spy.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('Greenhouse', () => {
    const response = {
      questions: [
        {
          label: 'Are you authorized to work in the US?',
          required: true,
          fields: [
            {
              name: 'work_auth',
              type: 'multi_value_single_select',
              values: [
                { value: '1', label: 'Yes' },
                { value: '0', label: 'No' },
              ],
            },
          ],
        },
      ],
    };

    it('fetches the questions-enabled Job Board API for a posting URL', async () => {
      const fetchImpl = stubFetch(response);

      await enrichWithApiOracle(
        'https://job-boards.greenhouse.io/greenhouse/jobs/8080711?gh_jid=8080711',
        [],
        fetchImpl,
      );

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://boards-api.greenhouse.io/v1/boards/greenhouse/jobs/8080711?questions=true',
      );
    });

    it('recognizes the legacy boards.greenhouse.io host too', async () => {
      const fetchImpl = stubFetch(response);

      await enrichWithApiOracle('https://boards.greenhouse.io/acme/jobs/12345', [], fetchImpl);

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://boards-api.greenhouse.io/v1/boards/acme/jobs/12345?questions=true',
      );
    });

    it('fills in required and options on the field whose label matches, ignoring surrounding whitespace and case', async () => {
      const fields = [question(' Are you authorized to work in the US? ')];

      const result = await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        fields,
        stubFetch(response),
      );

      expect(result[0]).toMatchObject({
        required: true,
        options: [
          { label: 'Yes', selector: null },
          { label: 'No', selector: null },
        ],
      });
    });

    it('keeps the DOM selector already recorded for a choice the API also knows about — overwriting it would trade a clickable choice for a label the Fill Step can only text-match', async () => {
      const fields = [
        question('Are you authorized to work in the US?', {
          options: [
            { label: 'Yes', selector: '#opt-yes' },
            { label: 'No', selector: '#opt-no' },
          ],
        }),
      ];
      const withExtraChoice = {
        questions: [
          {
            ...response.questions[0],
            fields: [
              {
                ...response.questions[0]!.fields[0]!,
                // The API knows a choice the rendered DOM didn't show.
                values: [
                  { value: '1', label: 'Yes' },
                  { value: '0', label: 'No' },
                  { value: '2', label: 'Prefer not to say' },
                ],
              },
            ],
          },
        ],
      };

      const result = await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        fields,
        stubFetch(withExtraChoice),
      );

      expect(result[0]!.options).toEqual([
        { label: 'Yes', selector: '#opt-yes' },
        { label: 'No', selector: '#opt-no' },
        { label: 'Prefer not to say', selector: null },
      ]);
    });

    it('does not attach an arbitrary selector when duplicate DOM labels match one API choice', async () => {
      const fields = [
        question('Are you authorized to work in the US?', {
          options: [
            { label: 'Yes', selector: '#opt-yes-a' },
            { label: ' yes ', selector: '#opt-yes-b' },
          ],
        }),
      ];

      const result = await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        fields,
        stubFetch(response),
      );

      expect(result[0]!.options?.[0]).toEqual({ label: 'Yes', selector: null });
    });

    it('leaves a field untouched when no question matches its label', async () => {
      const fields = [field({ label: 'Referral code' })];

      const result = await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        fields,
        stubFetch(response),
      );

      expect(result[0]).toEqual(fields[0]);
    });

    it('leaves options alone when the matching question lists no choices', async () => {
      const fields = [question('Why do you want to work here?')];
      const noChoices = {
        questions: [{ label: 'Why do you want to work here?', required: false, fields: [] }],
      };

      const result = await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        fields,
        stubFetch(noChoices),
      );

      expect(result[0]!.options).toBeUndefined();
    });
  });

  describe('Ashby', () => {
    // These used to assert that an Ashby posting URL produced
    // `POST https://api.ashbyhq.com/posting-api/job-posting/{id}`, and that a response shaped like
    // `applicationFormDefinition` enriched a field. Both passed for the whole life of the oracle,
    // which never enriched anything: the endpoint returns 401, and no public Ashby path serves that
    // response shape. Green tests over a dead adapter — so they went with it.
    it('recognizes no Ashby URL, because no Ashby oracle exists to be fooled into a 401', async () => {
      const fetchImpl = stubFetch({});

      await enrichWithApiOracle(
        'https://jobs.ashbyhq.com/acme/9f8b1c2d-0000-1111-2222-333344445555',
        [],
        fetchImpl,
      );

      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('SmartRecruiters', () => {
    it('fetches the configuration endpoint for a posting id in the last path segment', async () => {
      const fetchImpl = stubFetch({ questions: [] });

      await enrichWithApiOracle(
        'https://jobs.smartrecruiters.com/Acme/743999812345678-senior-engineer',
        [],
        fetchImpl,
      );

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://api.smartrecruiters.com/v1/postings/743999812345678/configuration',
      );
    });

    it('does not fetch when no posting id can be extracted', async () => {
      const fetchImpl = stubFetch({});

      await enrichWithApiOracle(
        'https://jobs.smartrecruiters.com/Acme/senior-engineer',
        [],
        fetchImpl,
      );

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('marks a question required when any of its fields is', async () => {
      const fields = [question('Work authorization')];
      const response = {
        questions: [
          {
            label: 'Work authorization',
            fields: [
              {
                type: 'SINGLE_SELECT',
                required: true,
                values: [
                  { id: 'yes', label: 'Yes' },
                  { id: 'no', label: 'No' },
                ],
              },
            ],
          },
        ],
      };

      const result = await enrichWithApiOracle(
        'https://jobs.smartrecruiters.com/Acme/743999812345678-x',
        fields,
        stubFetch(response),
      );

      expect(result[0]).toMatchObject({
        required: true,
        options: [
          { label: 'Yes', selector: null },
          { label: 'No', selector: null },
        ],
      });
    });

    it("keeps the DOM's own required flag when the matching question carries no fields, rather than overwriting it with a guess", async () => {
      const fields = [question('Work authorization', { required: true })];
      const response = { questions: [{ label: 'Work authorization', fields: [] }] };

      const result = await enrichWithApiOracle(
        'https://jobs.smartrecruiters.com/Acme/743999812345678-x',
        fields,
        stubFetch(response),
      );

      expect(result[0]!.required).toBe(true);
    });
  });

  describe('Workable', () => {
    it('fetches the application-form endpoint on the company subdomain', async () => {
      const fetchImpl = stubFetch({ questions: [] });

      await enrichWithApiOracle('https://acme.workable.com/j/ABC123', [], fetchImpl);

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://acme.workable.com/spi/v3/jobs/ABC123/application_form',
      );
    });

    it('does not fetch for the generic hosts, which carry no company subdomain to scope the API to', async () => {
      const fetchImpl = stubFetch({});

      for (const host of ['apply', 'jobs', 'www']) {
        await enrichWithApiOracle(`https://${host}.workable.com/j/ABC123`, [], fetchImpl);
      }

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('takes the subdomain from the end of the host, not from its first .workable.com', async () => {
      const fetchImpl = stubFetch({ questions: [] });

      await enrichWithApiOracle('https://a.workable.com.b.workable.com/j/ABC123', [], fetchImpl);

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://a.workable.com.b.workable.com/spi/v3/jobs/ABC123/application_form',
      );
    });

    it('fills in required and choices', async () => {
      const fields = [question('Work authorization')];
      const response = {
        questions: [{ label: 'Work authorization', required: true, choices: ['Yes'] }],
      };

      const result = await enrichWithApiOracle(
        'https://acme.workable.com/j/ABC123',
        fields,
        stubFetch(response),
      );

      expect(result[0]).toMatchObject({
        required: true,
        options: [{ label: 'Yes', selector: null }],
      });
    });
  });

  describe('falling back to the DOM-scraped fields', () => {
    const fields = [question('Work authorization')];

    it('returns them unchanged for a URL no platform recognizes, without fetching', async () => {
      const fetchImpl = stubFetch({});

      const result = await enrichWithApiOracle('https://jobs.lever.co/acme/123', fields, fetchImpl);

      expect(result).toEqual(fields);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns them unchanged for a malformed URL', async () => {
      const fetchImpl = stubFetch({});

      expect(await enrichWithApiOracle('not a url', fields, fetchImpl)).toEqual(fields);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns them unchanged when the API responds with an error status', async () => {
      const result = await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        fields,
        stubFetch({}, { ok: false }),
      );

      expect(result).toEqual(fields);
    });

    it('returns them unchanged when the request throws', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

      const result = await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        fields,
        fetchImpl,
      );

      expect(result).toEqual(fields);
    });

    it('returns them unchanged when the response is not the shape the platform documents', async () => {
      const result = await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        fields,
        stubFetch({ unexpected: 'shape' }),
      );

      expect(result).toEqual(fields);
    });
  });

  /**
   * The one failure mode that looks exactly like success: the oracle answered, but its wording
   * matched none of the detected labels, so the fields come back untouched — the same result as no
   * oracle recognizing the URL at all. Nothing distinguished the two until this warning existed.
   */
  describe('reporting an enrichment that had no effect', () => {
    const schemaWithOneQuestion = {
      questions: [
        {
          label: 'Are you authorized to work in the United States?',
          required: true,
          fields: [{ name: 'work_auth', type: 'input_text', values: [] }],
        },
      ],
    };

    it('warns when the schema matched none of the detected fields by label', async () => {
      const result = await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        // The page words the same question differently, so the label lookup misses.
        [question('Work authorization')],
        stubFetch(schemaWithOneQuestion),
      );

      expect(result).toEqual([question('Work authorization')]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('had no effect'));
    });

    it('stays quiet when at least one field did match', async () => {
      await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        [question('Are you authorized to work in the United States?')],
        stubFetch(schemaWithOneQuestion),
      );

      expect(console.warn).not.toHaveBeenCalled();
    });

    it('stays quiet when the schema carried no questions at all — nothing was expected to match', async () => {
      await enrichWithApiOracle(
        'https://boards.greenhouse.io/acme/jobs/1',
        [question('Work authorization')],
        stubFetch({ questions: [] }),
      );

      expect(console.warn).not.toHaveBeenCalled();
    });
  });
});

describe('carryEnrichment', () => {
  it("keeps the API's option wording while taking the fresh scan's selectors", () => {
    const analyzed = [
      question('Work authorization', {
        options: [
          { label: 'Yes, I am authorized', selector: '#opt-yes' },
          { label: 'No, I require sponsorship', selector: null },
        ],
      }),
    ];
    // The same question re-scanned: the page's own wording, and freshly tagged elements.
    const scanned = [
      question('Work authorization', {
        id: 'q9',
        options: [
          { label: 'Yes', selector: '#new-yes' },
          { label: 'No', selector: '#new-no' },
        ],
      }),
    ];

    const [carried] = carryEnrichment(scanned, analyzed);

    // The answer was drafted against — and constrained to — the API's wording, so that is what the
    // Fill Step has to be able to match.
    expect(carried!.options?.map((option) => option.label)).toEqual([
      'Yes, I am authorized',
      'No, I require sponsorship',
    ]);
    expect(carried!.id).toBe('q9');
  });

  it("carries the fresh scan's selector, not the stale one the earlier scan recorded", () => {
    // The point of re-scanning at fill time: the page may have re-mounted and re-tagged. Asserting
    // the labels alone would pass just as happily if the selector were dropped or left stale.
    const analyzed = [
      question('Work authorization', {
        options: [{ label: 'Yes', selector: '#stale-yes' }],
      }),
    ];
    const scanned = [
      question('Work authorization', {
        id: 'q9',
        options: [{ label: 'Yes', selector: '#fresh-yes' }],
      }),
    ];

    expect(carryEnrichment(scanned, analyzed)[0]!.options).toEqual([
      { label: 'Yes', selector: '#fresh-yes' },
    ]);
  });

  it('says so when the API words every choice differently from the page, instead of returning unclickable options quietly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const analyzed = [
      question('Work authorization', {
        // No selector: `mergeOptions` already failed to pair this wording at enrichment time.
        options: [{ label: 'Yes, I am authorized to work in the US', selector: null }],
      }),
    ];
    const scanned = [
      question('Work authorization', { id: 'q9', options: [{ label: 'Yes', selector: '#yes' }] }),
    ];

    const [carried] = carryEnrichment(scanned, analyzed);

    // Nothing was lost in the carrying — the selector was already null — but the field cannot fill,
    // and that has to be visible rather than looking like a successful enrichment.
    expect(carried!.options).toEqual([
      { label: 'Yes, I am authorized to work in the US', selector: null },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('will not fill'));
  });

  it('stays quiet when the page had no selectors to pair in the first place', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const analyzed = [
      question('Work authorization', { options: [{ label: 'Yes', selector: null }] }),
    ];
    const scanned = [
      question('Work authorization', { id: 'q9', options: [{ label: 'Yes', selector: null }] }),
    ];

    carryEnrichment(scanned, analyzed);

    expect(warn).not.toHaveBeenCalled();
  });

  it("carries an oracle's required flag onto the re-scanned field, which the raw DOM had no way to know", () => {
    const analyzed = [question('Work authorization', { required: true })];
    const scanned = [question('Work authorization', { id: 'q9', required: false })];

    expect(carryEnrichment(scanned, analyzed)[0]!.required).toBe(true);
  });

  it('never lowers a required flag the fresh page asserts on its own', () => {
    const analyzed = [question('Work authorization', { required: false })];
    const scanned = [question('Work authorization', { id: 'q9', required: true })];

    expect(carryEnrichment(scanned, analyzed)[0]!.required).toBe(true);
  });

  it('leaves a field the earlier scan never saw exactly as scanned', () => {
    const scanned = [question('A question that appeared later', { id: 'q9' })];

    expect(carryEnrichment(scanned, [])).toEqual(scanned);
  });

  it('matches on normalized label, so trivial re-wording between scans still carries', () => {
    const analyzed = [
      question('Work Authorization', { options: [{ label: 'Yes', selector: null }] }),
    ];
    const scanned = [question('  work authorization  ', { id: 'q9' })];

    expect(carryEnrichment(scanned, analyzed)[0]!.options).toHaveLength(1);
  });
});
