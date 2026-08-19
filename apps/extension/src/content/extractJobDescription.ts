import type { ScrapedJobDescription } from '../lib/messages';
import { jobKeyForUrl } from '../lib/jobContext';

const MIN_DESCRIPTION_LENGTH = 250;
const MAX_DESCRIPTION_LENGTH = 50_000;

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'DT',
  'DD',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'TR',
  'UL',
]);

const SKIPPED_TAGS = new Set([
  'BUTTON',
  'CANVAS',
  'FORM',
  'IFRAME',
  'INPUT',
  'NAV',
  'NOSCRIPT',
  'SCRIPT',
  'SELECT',
  'STYLE',
  'SVG',
  'TEXTAREA',
]);

const STRONG_SELECTORS = [
  '[itemprop="description"]',
  '[data-automation-id="jobPostingDescription"]',
  '[data-testid*="job-description" i]',
  '[data-testid*="jobDescription" i]',
  '[data-qa*="job-description" i]',
  '[data-ui*="job-description" i]',
  '[id*="job-description" i]',
  '[id*="jobDescription" i]',
  '[class*="job-description" i]',
  '[class*="jobDescription" i]',
].join(',');

const SEMANTIC_HEADING =
  /\b(?:about (?:the )?(?:company|role|job|team|opportunity|us)|company overview|the role|the opportunity|what you(?:'|’)ll do|what you(?:'|’)ll bring|what we(?:'|’)re looking for|who you are|your impact|responsibilities|requirements|qualifications|skills|experience)\b/i;

const APPLICATION_BOUNDARY =
  /^(?:apply(?: for this job| now)?|application(?: form)?|submit (?:an )?application|similar jobs|related jobs|job alerts?|share this job)$/i;

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function shouldSkip(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName)) return true;
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true;

  const role = element.getAttribute('role');
  if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return true;

  const marker = `${element.id} ${element.className}`;
  return /(?:^|\s|[-_])(?:cookie|consent|breadcrumb|social-share|job-alert|related-jobs?|similar-jobs?)(?:\s|[-_]|$)/i.test(
    marker,
  );
}

/** Serializes prose while retaining headings, paragraphs and list boundaries. */
function textFromRoot(root: Node): string {
  const chunks: string[] = [];

  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.replace(/\s+/g, ' ').trim();
      if (text) chunks.push(`${text} `);
      return;
    }

    if (!isElement(node) && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (isElement(node) && shouldSkip(node)) return;

    if (isElement(node) && node.tagName === 'BR') {
      chunks.push('\n');
      return;
    }

    const block = isElement(node) && BLOCK_TAGS.has(node.tagName);
    if (block) chunks.push(node.tagName === 'LI' ? '\n- ' : '\n');
    for (const child of node.childNodes) visit(child);
    if (block) chunks.push('\n');
  }

  visit(root);
  const lines = chunks
    .join('')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1]);

  let text = lines.join('\n');
  const boundary = lines.findIndex((line, index) => {
    if (index === 0 || !APPLICATION_BOUNDARY.test(line)) return false;
    return lines.slice(0, index).join('\n').length >= MIN_DESCRIPTION_LENGTH;
  });
  if (boundary >= 0) text = lines.slice(0, boundary).join('\n');

  if (text.length > MAX_DESCRIPTION_LENGTH) {
    const end = text.lastIndexOf('\n', MAX_DESCRIPTION_LENGTH);
    text = text.slice(0, end > MIN_DESCRIPTION_LENGTH ? end : MAX_DESCRIPTION_LENGTH).trim();
  }
  return text.trim();
}

function structuredValue(value: unknown, document: Document): string {
  if (Array.isArray(value)) {
    return value
      .map((entry) => structuredValue(entry, document))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value !== 'string') return '';

  // Some publishers mix valid HTML with one or more entity-encoded HTML layers in the same
  // JobPosting.description. Decode entities in an RCDATA element first: unlike taking a parsed
  // fragment's textContent, this keeps already-valid `<p>`/`<strong>` markup intact while turning
  // Brex-style `&amp;lt;/p&amp;gt;` back into tags for the real parse below.
  let html = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = html;
    const decoded = decoder.value;
    if (decoded === html) break;
    html = decoded;
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  return textFromRoot(template.content);
}

function hasType(value: unknown, expected: string): boolean {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    const target = expected.toLowerCase();
    return (
      normalized === target ||
      normalized.endsWith(`/${target}`) ||
      normalized.endsWith(`#${target}`)
    );
  }
  return Array.isArray(value) && value.some((entry) => hasType(entry, expected));
}

function findJobPostings(value: unknown, postings: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) findJobPostings(entry, postings);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const object = value as Record<string, unknown>;
  if (hasType(object['@type'], 'JobPosting')) postings.push(object);
  for (const child of Object.values(object)) findJobPostings(child, postings);
}

function organizationName(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const name = (value as Record<string, unknown>).name;
  return typeof name === 'string' ? name.trim() : '';
}

interface StructuredCandidate extends ScrapedJobDescription {
  urlMatch: 'match' | 'mismatch' | 'unknown';
  title: string;
}

function resolvedJobKey(value: string, document: Document): string | null {
  try {
    return jobKeyForUrl(new URL(value, document.location.href).href);
  } catch {
    return null;
  }
}

function scrapedCandidate(candidate: StructuredCandidate): ScrapedJobDescription {
  return { text: candidate.text, score: candidate.score, source: candidate.source };
}

function structuredCandidate(document: Document): ScrapedJobDescription | null {
  const postings: Record<string, unknown>[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      findJobPostings(JSON.parse(script.textContent ?? ''), postings);
    } catch {
      // One malformed analytics block must not prevent DOM extraction or another valid JSON-LD block.
    }
  }

  const currentKey = jobKeyForUrl(document.location.href);
  const candidates = postings.flatMap((posting): StructuredCandidate[] => {
    const description = structuredValue(posting.description, document);
    if (description.length < MIN_DESCRIPTION_LENGTH) return [];

    const sections: string[] = [];
    const title = structuredValue(posting.title, document);
    const company = organizationName(posting.hiringOrganization);
    if (title) sections.push(title);
    if (company && !description.toLowerCase().includes(company.toLowerCase()))
      sections.push(company);
    sections.push(description);

    for (const [heading, key] of [
      ['Responsibilities', 'responsibilities'],
      ['Qualifications', 'qualifications'],
      ['Skills', 'skills'],
    ] as const) {
      const value = structuredValue(posting[key], document);
      if (value && !description.toLowerCase().includes(value.toLowerCase())) {
        sections.push(`${heading}\n${value}`);
      }
    }

    const postingUrl =
      typeof posting.url === 'string'
        ? posting.url
        : typeof posting['@id'] === 'string'
          ? posting['@id']
          : null;
    const postingKey = postingUrl ? resolvedJobKey(postingUrl, document) : null;
    const urlMatch =
      !postingUrl || !postingKey || !currentKey
        ? 'unknown'
        : postingKey === currentKey
          ? 'match'
          : 'mismatch';
    return [
      {
        text: sections.join('\n\n').slice(0, MAX_DESCRIPTION_LENGTH).trim(),
        score: 120 + Math.min(30, Math.floor(description.length / 1000)),
        source: 'structured-data',
        urlMatch,
        title,
      },
    ];
  });

  const byScore = (first: StructuredCandidate, second: StructuredCandidate) =>
    second.score - first.score || first.text.length - second.text.length;
  const exactMatches = candidates
    .filter((candidate) => candidate.urlMatch === 'match')
    .sort(byScore);
  if (exactMatches[0]) return scrapedCandidate(exactMatches[0]);

  // An explicit URL for another posting is never allowed to win on text length. For URL-less
  // entries, use a unique page-title match; if several remain indistinguishable, let the focused DOM
  // extractor decide rather than selecting a related/stale posting arbitrarily.
  const unknown = candidates.filter((candidate) => candidate.urlMatch === 'unknown');
  if (unknown.length === 1) return scrapedCandidate(unknown[0]);
  const pageTitle = `${document.querySelector('h1')?.textContent ?? ''} ${document.title}`
    .trim()
    .toLowerCase();
  const titleMatches = unknown.filter(
    (candidate) => candidate.title && pageTitle.includes(candidate.title.toLowerCase()),
  );
  return titleMatches.length === 1 ? scrapedCandidate(titleMatches[0]) : null;
}

function openRoots(document: Document): ParentNode[] {
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index += 1) {
    for (const element of roots[index].querySelectorAll('*')) {
      if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
    }
  }
  return roots;
}

function scoreElement(element: Element, text: string, strong: boolean): number {
  if (text.length < MIN_DESCRIPTION_LENGTH) return Number.NEGATIVE_INFINITY;

  const headings = [...element.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((heading) =>
    SEMANTIC_HEADING.test(heading.textContent ?? ''),
  ).length;
  const paragraphs = element.querySelectorAll('p').length;
  const listItems = element.querySelectorAll('li').length;
  const controls = element.querySelectorAll('input,select,textarea,button').length;
  const linkText = [...element.querySelectorAll('a')].reduce(
    (total, link) => total + (link.textContent?.trim().length ?? 0),
    0,
  );

  let score = Math.min(30, Math.floor(text.length / 350));
  if (strong) score += 55;
  if (element.matches('main,article,[role="main"]')) score += 18;
  score += Math.min(36, headings * 9);
  score += Math.min(12, paragraphs * 2);
  score += Math.min(12, listItems);
  score -= Math.min(40, controls * 4);
  if (linkText > text.length * 0.35) score -= 25;
  if (element.tagName === 'BODY') score -= 12;
  if (text.length > 35_000) score -= 15;
  return score;
}

function domCandidate(document: Document): ScrapedJobDescription | null {
  const candidates = new Map<Element, boolean>();

  for (const root of openRoots(document)) {
    for (const element of root.querySelectorAll(STRONG_SELECTORS)) candidates.set(element, true);
    for (const element of root.querySelectorAll('main,article,[role="main"]')) {
      if (!candidates.has(element)) candidates.set(element, false);
    }

    for (const heading of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (!SEMANTIC_HEADING.test(heading.textContent ?? '')) continue;
      let ancestor = heading.parentElement;
      for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'BODY') break;
        if (!candidates.has(ancestor)) candidates.set(ancestor, false);
      }
    }
  }

  if (document.body) candidates.set(document.body, false);

  const scored = [...candidates].flatMap(([element, strong]): ScrapedJobDescription[] => {
    const text = textFromRoot(element);
    const score = scoreElement(element, text, strong);
    return score >= 35 ? [{ text, score, source: 'dom' }] : [];
  });

  return scored.sort((a, b) => b.score - a.score || a.text.length - b.text.length)[0] ?? null;
}

/** Extracts the best confident Job Description candidate currently present in a document. */
export function extractJobDescription(document: Document): ScrapedJobDescription | null {
  return structuredCandidate(document) ?? domCandidate(document);
}

/**
 * Gives client-rendered ATS pages a short bounded window to mount their posting after the click.
 * No observer is left running on ordinary pages after success or timeout.
 */
export function extractJobDescriptionWhenReady(
  document: Document,
  { timeoutMs = 2_500, settleMs = 150 }: { timeoutMs?: number; settleMs?: number } = {},
): Promise<ScrapedJobDescription | null> {
  const immediate = extractJobDescription(document);
  if (immediate || !document.body) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settleId: ReturnType<typeof setTimeout> | undefined;
    let finished = false;

    const finish = (candidate: ScrapedJobDescription | null) => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(settleId);
      clearTimeout(timeoutId);
      resolve(candidate);
    };

    const observer = new MutationObserver(() => {
      clearTimeout(settleId);
      settleId = setTimeout(() => {
        const candidate = extractJobDescription(document);
        if (candidate) finish(candidate);
      }, settleMs);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeoutId = setTimeout(() => finish(extractJobDescription(document)), timeoutMs);
  });
}
