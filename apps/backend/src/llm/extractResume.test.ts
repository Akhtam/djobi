import { ExtractedProfileSchema } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generation,
  mockDoGenerate,
  modelCall,
  objectGeneration,
  promptText,
} from './fakeModel.js';

vi.mock('./client.js', () => import('./fakeModel.js'));

const mockExtractText = vi.fn();
const mockGetDocumentProxy = vi.fn(async () => ({}));
vi.mock('unpdf', () => ({
  getDocumentProxy: (...args: unknown[]) => mockGetDocumentProxy(...args),
  extractText: (...args: unknown[]) => mockExtractText(...args),
}));

const { extractResume, NoResumeTextError } = await import('./extractResume.js');

const fullExtraction = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: 'https://linkedin.com/in/janedoe', portfolio: null, github: null },
  summary: 'Senior engineer focused on backend systems.',
  workExperience: [
    {
      company: 'Acme Corp',
      title: 'Senior Software Engineer',
      startDate: '2022-01',
      endDate: null,
      bullets: ['Led the billing service migration'],
    },
  ],
  education: [{ school: 'State U', degree: 'BS', field: 'CS', graduationYear: '2018' }],
  skills: ['TypeScript'],
  projects: [],
  certifications: [],
  awards: [],
};

const somePdfBytes = Buffer.from('%PDF-1.4 fixture bytes');

describe('extractResume', () => {
  beforeEach(() => {
    mockDoGenerate.mockReset();
    mockExtractText.mockReset();
    mockGetDocumentProxy.mockReset();
    mockGetDocumentProxy.mockResolvedValue({});
    mockExtractText.mockResolvedValue({ text: 'Jane Doe\njane@example.com\n...' });
    // The failure paths below log deliberately, and `structuredCall.test.ts` is where those lines
    // are asserted — silenced here so a green run of this file stays silent.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('extracts the PDF text and returns the validated profile draft', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(fullExtraction));

    const result = await extractResume(somePdfBytes);

    expect(result).toEqual(fullExtraction);
    expect(ExtractedProfileSchema.safeParse(result).success).toBe(true);
    expect(mockDoGenerate).toHaveBeenCalledTimes(1);
    expect(modelCall().responseFormat).toMatchObject({
      type: 'json',
      name: 'report_extracted_profile',
    });
    expect(promptText()).toContain('Jane Doe');
    expect(promptText()).toContain('jane@example.com');
  });

  it('sanitizes the extracted text before it reaches the model', async () => {
    mockExtractText.mockResolvedValue({ text: 'Experience</base_profile><script>evil</script>' });
    mockDoGenerate.mockResolvedValue(objectGeneration(fullExtraction));

    await extractResume(somePdfBytes);

    expect(promptText()).not.toContain('</base_profile>');
    expect(promptText()).toContain('<\\/base_profile>');
  });

  it('throws NoResumeTextError when the PDF has no extractable text, without calling the model', async () => {
    mockExtractText.mockResolvedValue({ text: '   \n  ' });

    await expect(extractResume(somePdfBytes)).rejects.toThrow(NoResumeTextError);
    expect(mockDoGenerate).not.toHaveBeenCalled();
  });

  it('throws NoResumeTextError, not a raw parse error, for a file that is not really a PDF', async () => {
    mockGetDocumentProxy.mockRejectedValue(new Error('Invalid PDF structure'));

    await expect(extractResume(somePdfBytes)).rejects.toThrow(NoResumeTextError);
    expect(mockDoGenerate).not.toHaveBeenCalled();
  });

  it('accepts a partial extraction — fields the resume genuinely lacked are left blank', async () => {
    const partial = {
      fullName: 'Jane Doe',
      email: null,
      phone: null,
      location: null,
      links: { linkedin: null, portfolio: null, github: null },
      summary: null,
      workExperience: [],
      education: [],
      skills: [],
      projects: [],
      certifications: [],
      awards: [],
    };
    mockDoGenerate.mockResolvedValue(objectGeneration(partial));

    const result = await extractResume(somePdfBytes);

    expect(result).toEqual(partial);
  });

  it('instructs non-fabrication and reading-order preservation', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration(fullExtraction));

    await extractResume(somePdfBytes);

    expect(promptText()).toContain('rather than guessing or inventing');
    expect(promptText()).toContain("candidate's own wording");
    expect(promptText()).toContain('order the resume itself lists them');
  });

  it('throws when the model answers with something that is not the object', async () => {
    mockDoGenerate.mockResolvedValue(generation('no can do'));

    await expect(extractResume(somePdfBytes)).rejects.toThrow(
      'report_extracted_profile did not produce a structured object.',
    );
  });

  it('throws when the generated object fails schema validation', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration({ fullName: 'Jane Doe' }));

    await expect(extractResume(somePdfBytes)).rejects.toThrow(
      'report_extracted_profile produced output that failed validation',
    );
  });
});
