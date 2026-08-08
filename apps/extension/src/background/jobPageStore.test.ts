import { describe, expect, it } from 'vitest';
import { getJobPageData, setJobPageData } from './jobPageStore';

describe('jobPageStore', () => {
  it('returns the job page data previously stored for a tab', () => {
    setJobPageData(1, { pageText: 'Senior Engineer at Acme', fields: [] });

    expect(getJobPageData(1)).toEqual({ pageText: 'Senior Engineer at Acme', fields: [] });
  });

  it('returns null for a tab with no stored job page data', () => {
    expect(getJobPageData(999)).toBeNull();
  });
});
