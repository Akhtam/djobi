import type { DetectedField } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enrichWithApiOracle,
  enrichWithGreenhouseApi,
  greenhouseJobBoardApiUrl,
  mergeAshbyQuestions,
  mergeGreenhouseQuestions,
  mergeSmartRecruitersQuestions,
  mergeWorkableQuestions,
  parseAshbyUrl,
  parseGreenhouseUrl,
  parseSmartRecruitersUrl,
  parseWorkableUrl,
} from './apiDetectors';

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

describe('parseGreenhouseUrl', () => {
  it('extracts the board token and job id from a job-boards.greenhouse.io URL', () => {
    expect(
      parseGreenhouseUrl('https://job-boards.greenhouse.io/greenhouse/jobs/8080711?gh_jid=8080711'),
    ).toEqual({ boardToken: 'greenhouse', jobId: '8080711' });
  });

  it('extracts the board token and job id from the legacy boards.greenhouse.io URL shape', () => {
    expect(parseGreenhouseUrl('https://boards.greenhouse.io/acme/jobs/12345')).toEqual({
      boardToken: 'acme',
      jobId: '12345',
    });
  });

  it('returns null for a non-Greenhouse URL', () => {
    expect(parseGreenhouseUrl('https://jobs.lever.co/acme/12345')).toBeNull();
  });

  it('returns null for a Greenhouse URL that is not a job posting page', () => {
    expect(parseGreenhouseUrl('https://job-boards.greenhouse.io/greenhouse')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(parseGreenhouseUrl('not a url')).toBeNull();
  });
});

describe('greenhouseJobBoardApiUrl', () => {
  it('builds the questions-enabled Job Board API URL for a board token/job id', () => {
    expect(greenhouseJobBoardApiUrl({ boardToken: 'greenhouse', jobId: '8080711' })).toBe(
      'https://boards-api.greenhouse.io/v1/boards/greenhouse/jobs/8080711?questions=true',
    );
  });
});

describe('mergeGreenhouseQuestions', () => {
  it('fills in required/options on a field whose label matches an API question, by normalized label text', () => {
    const fields = [
      field({
        id: 'combobox-1',
        label: ' Are you authorized to work in the US? ',
        elementRole: 'combobox',
        category: 'question',
      }),
    ];
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

    const result = mergeGreenhouseQuestions(fields, response);

    expect(result[0]).toMatchObject({
      required: true,
      options: [
        { label: 'Yes', selector: null },
        { label: 'No', selector: null },
      ],
    });
  });

  it('leaves a field unchanged when no API question matches its label', () => {
    const fields = [field({ id: 'f1', label: 'Referral code' })];
    const response = { questions: [{ label: 'Resume/CV', required: true, fields: [] }] };

    const result = mergeGreenhouseQuestions(fields, response);

    expect(result[0]).toEqual(fields[0]);
  });

  it('keeps the DOM selector already recorded for a choice the API also knows about — overwriting it would trade a clickable choice for a label the Fill Step can only text-match', () => {
    const fields = [
      field({
        id: 'combobox-1',
        label: 'Are you authorized to work in the US?',
        elementRole: 'combobox',
        category: 'question',
        options: [
          { label: 'Yes', selector: '#opt-yes' },
          { label: 'No', selector: '#opt-no' },
        ],
      }),
    ];
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
                // The API knows a choice the rendered DOM didn't show.
                { value: '2', label: 'Prefer not to say' },
              ],
            },
          ],
        },
      ],
    };

    const result = mergeGreenhouseQuestions(fields, response);

    expect(result[0].options).toEqual([
      { label: 'Yes', selector: '#opt-yes' },
      { label: 'No', selector: '#opt-no' },
      { label: 'Prefer not to say', selector: null },
    ]);
  });

  it('preserves an already-resolved options list when the matching question has no select-type field', () => {
    const fields = [
      field({ id: 'f1', label: 'Why do you want to work here?', category: 'question' }),
    ];
    const response = {
      questions: [{ label: 'Why do you want to work here?', required: false, fields: [] }],
    };

    const result = mergeGreenhouseQuestions(fields, response);

    expect(result[0]).toMatchObject({ required: false });
    expect(result[0].options).toBeUndefined();
  });
});

describe('parseAshbyUrl', () => {
  it('extracts the org name and job id from a jobs.ashbyhq.com posting URL', () => {
    expect(
      parseAshbyUrl('https://jobs.ashbyhq.com/Ashby/9f8b1c2d-0000-1111-2222-333344445555'),
    ).toEqual({
      orgName: 'Ashby',
      jobId: '9f8b1c2d-0000-1111-2222-333344445555',
    });
  });

  it('returns null for a non-Ashby URL', () => {
    expect(parseAshbyUrl('https://jobs.lever.co/acme/123')).toBeNull();
  });

  it('returns null for the job board root with no specific job id', () => {
    expect(parseAshbyUrl('https://jobs.ashbyhq.com/Ashby')).toBeNull();
  });
});

describe('mergeAshbyQuestions', () => {
  it('fills in required/options on a field whose label matches an API field title', () => {
    const fields = [
      field({ id: 'f1', label: 'Are you authorized to work in the US?', category: 'question' }),
    ];
    const response = {
      applicationFormDefinition: {
        sections: [
          {
            fields: [
              {
                title: 'Are you authorized to work in the US?',
                isRequired: true,
                selectableValues: [
                  { label: 'Yes', value: 'yes' },
                  { label: 'No', value: 'no' },
                ],
              },
            ],
          },
        ],
      },
    };

    const result = mergeAshbyQuestions(fields, response);

    expect(result[0]).toMatchObject({
      required: true,
      options: [
        { label: 'Yes', selector: null },
        { label: 'No', selector: null },
      ],
    });
  });

  it('leaves a field unchanged when no API field matches its label', () => {
    const fields = [field({ id: 'f1', label: 'Referral code' })];
    const response = { applicationFormDefinition: { sections: [] } };

    expect(mergeAshbyQuestions(fields, response)).toEqual(fields);
  });
});

describe('parseSmartRecruitersUrl', () => {
  it('extracts a leading numeric/uuid posting id from the last path segment', () => {
    expect(
      parseSmartRecruitersUrl(
        'https://jobs.smartrecruiters.com/Acme/743999812345678-senior-engineer',
      ),
    ).toEqual({ postingId: '743999812345678' });
  });

  it('returns null for a non-SmartRecruiters URL', () => {
    expect(parseSmartRecruitersUrl('https://jobs.lever.co/acme/123')).toBeNull();
  });

  it('returns null when no posting id can be extracted', () => {
    expect(
      parseSmartRecruitersUrl('https://jobs.smartrecruiters.com/Acme/senior-engineer'),
    ).toBeNull();
  });
});

describe('mergeSmartRecruitersQuestions', () => {
  it('fills in required/options on a field whose label matches an API question label', () => {
    const fields = [field({ id: 'f1', label: 'Work authorization', category: 'question' })];
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

    const result = mergeSmartRecruitersQuestions(fields, response);

    expect(result[0]).toMatchObject({
      required: true,
      options: [
        { label: 'Yes', selector: null },
        { label: 'No', selector: null },
      ],
    });
  });

  it('leaves a field unchanged when no API question matches its label', () => {
    const fields = [field({ id: 'f1', label: 'Referral code' })];
    const response = { questions: [{ label: 'Resume', fields: [] }] };

    expect(mergeSmartRecruitersQuestions(fields, response)).toEqual(fields);
  });
});

describe('parseWorkableUrl', () => {
  it('extracts the company subdomain and shortcode from a company-subdomain apply URL', () => {
    expect(parseWorkableUrl('https://acme.workable.com/j/ABCDEF1234')).toEqual({
      subdomain: 'acme',
      shortcode: 'ABCDEF1234',
    });
  });

  it('returns null for the generic apply.workable.com host, which has no company subdomain to target the API with', () => {
    expect(parseWorkableUrl('https://apply.workable.com/j/ABCDEF1234')).toBeNull();
  });

  it('returns null for a non-Workable URL', () => {
    expect(parseWorkableUrl('https://jobs.lever.co/acme/123')).toBeNull();
  });
});

describe('mergeWorkableQuestions', () => {
  it('fills in required/options on a field whose label matches an API question label', () => {
    const fields = [
      field({ id: 'f1', label: 'Are you authorized to work in the US?', category: 'question' }),
    ];
    const response = {
      questions: [
        {
          label: 'Are you authorized to work in the US?',
          required: true,
          choices: ['Yes', 'No'],
        },
      ],
    };

    const result = mergeWorkableQuestions(fields, response);

    expect(result[0]).toMatchObject({
      required: true,
      options: [
        { label: 'Yes', selector: null },
        { label: 'No', selector: null },
      ],
    });
  });

  it('leaves a field unchanged when no API question matches its label', () => {
    const fields = [field({ id: 'f1', label: 'Referral code' })];
    const response = { questions: [{ label: 'Resume', required: true, choices: [] }] };

    expect(mergeWorkableQuestions(fields, response)).toEqual(fields);
  });
});

describe('enrichWithApiOracle', () => {
  const fields = [field({ id: 'f1', label: 'Are you authorized to work in the US?' })];

  it('dispatches to the Greenhouse oracle for a Greenhouse URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ questions: [] }), { status: 200 }));

    await enrichWithApiOracle(
      'https://job-boards.greenhouse.io/greenhouse/jobs/8080711',
      fields,
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/greenhouse/jobs/8080711?questions=true',
    );
  });

  it('dispatches to the Ashby oracle for an Ashby URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ applicationFormDefinition: { sections: [] } }), {
          status: 200,
        }),
      );

    await enrichWithApiOracle(
      'https://jobs.ashbyhq.com/Ashby/9f8b1c2d-0000-1111-2222-333344445555',
      fields,
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns fields unchanged for a platform with no matching oracle', async () => {
    const fetchImpl = vi.fn();

    const result = await enrichWithApiOracle(
      'https://careers-acme.icims.com/jobs/1',
      fields,
      fetchImpl,
    );

    expect(result).toBe(fields);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('enrichWithGreenhouseApi', () => {
  const fields = [field({ id: 'f1', label: 'Are you authorized to work in the US?' })];

  it('fetches the Job Board API and merges its questions onto the given fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          questions: [
            {
              label: 'Are you authorized to work in the US?',
              required: true,
              fields: [
                {
                  name: 'work_auth',
                  type: 'multi_value_single_select',
                  values: [{ value: '1', label: 'Yes' }],
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await enrichWithGreenhouseApi(
      'https://job-boards.greenhouse.io/greenhouse/jobs/8080711',
      fields,
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/greenhouse/jobs/8080711?questions=true',
    );
    expect(result[0]).toMatchObject({
      required: true,
      options: [{ label: 'Yes', selector: null }],
    });
  });

  it('returns the fields unchanged when the URL is not a Greenhouse job posting', async () => {
    const fetchImpl = vi.fn();

    const result = await enrichWithGreenhouseApi(
      'https://jobs.lever.co/acme/123',
      fields,
      fetchImpl,
    );

    expect(result).toBe(fields);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the fields unchanged when the API request fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));

    const result = await enrichWithGreenhouseApi(
      'https://job-boards.greenhouse.io/greenhouse/jobs/8080711',
      fields,
      fetchImpl,
    );

    expect(result).toEqual(fields);
  });

  it('returns the fields unchanged when fetch itself throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network error'));

    const result = await enrichWithGreenhouseApi(
      'https://job-boards.greenhouse.io/greenhouse/jobs/8080711',
      fields,
      fetchImpl,
    );

    expect(result).toEqual(fields);
  });
});
