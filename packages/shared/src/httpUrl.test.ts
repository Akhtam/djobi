import { describe, expect, it } from 'vitest';
import { HttpUrlSchema, isHttpUrl } from './httpUrl.js';

describe('isHttpUrl', () => {
  it('accepts the two schemes a job posting is served over', () => {
    expect(isHttpUrl('https://jobs.ashbyhq.com/acme/9f8b1c2d')).toBe(true);
    expect(isHttpUrl('http://careers.example.com/jobs/1')).toBe(true);
  });

  it('accepts a URL padded with whitespace, which is what a paste looks like', () => {
    expect(isHttpUrl('  https://jobs.lever.co/acme/role-1  ')).toBe(true);
  });

  it('rejects the schemes that parse as URLs but are not postings', () => {
    // `javascript:` is the one that matters: it parses, so `z.string().url()` accepts it, and the
    // dashboard renders a stored `jobUrl` as an `<a href>`.
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('JavaScript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script></script>')).toBe(false);
    expect(isHttpUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('httpx://example.com')).toBe(false);
  });

  it('rejects what is not a URL at all', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('acme.com/jobs/1')).toBe(false);
  });
});

describe('HttpUrlSchema', () => {
  it('parses an http(s) URL', () => {
    expect(HttpUrlSchema.parse('https://acme.com/jobs/1')).toBe('https://acme.com/jobs/1');
  });

  it('refuses a non-http scheme that `z.string().url()` alone would accept', () => {
    expect(HttpUrlSchema.safeParse('javascript:alert(document.cookie)').success).toBe(false);
  });
});
