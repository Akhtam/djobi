import type { DetectedField } from '@djobi/shared';

export interface GreenhouseUrlInfo {
  boardToken: string;
  jobId: string;
}

/**
 * Parses a Greenhouse job posting URL (`job-boards.greenhouse.io/{boardToken}/jobs/{jobId}`, or
 * the legacy `boards.greenhouse.io/{boardToken}/jobs/{jobId}` shape) into its board token + job
 * id, or `null` if the URL isn't a Greenhouse job posting.
 */
export function parseGreenhouseUrl(url: string): GreenhouseUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!/(^|\.)greenhouse\.io$/.test(parsed.hostname)) return null;

  const match = parsed.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (!match) return null;

  return { boardToken: match[1], jobId: match[2] };
}

/** The questions-enabled Greenhouse Job Board API URL for a parsed posting. */
export function greenhouseJobBoardApiUrl(info: GreenhouseUrlInfo): string {
  return `https://boards-api.greenhouse.io/v1/boards/${info.boardToken}/jobs/${info.jobId}?questions=true`;
}

interface GreenhouseQuestionField {
  name: string;
  type: string;
  values: { value: string; label: string }[];
}

interface GreenhouseQuestion {
  label: string;
  required: boolean;
  fields: GreenhouseQuestionField[];
}

interface GreenhouseJobResponse {
  questions: GreenhouseQuestion[];
}

const normalize = (text: string) => text.trim().toLowerCase();

/**
 * Merges Greenhouse's Job Board API question schema onto matching `DetectedField`s, by normalized
 * label text (not DOM id — a react-select combobox's own DOM id is an internal, generated one,
 * not the API's stable field name, but its accessible label text is the same string a candidate
 * reads either way). Fills in `required` and `options` — the concrete fix for comboboxes whose
 * option list isn't in the DOM at page-load time (see `detectFields.ts`'s `resolveComboboxOptions`)
 * — without touching fields that have no matching API question.
 */
export function mergeGreenhouseQuestions(
  fields: DetectedField[],
  response: GreenhouseJobResponse,
): DetectedField[] {
  const byLabel = new Map(response.questions.map((q) => [normalize(q.label), q]));

  return fields.map((field) => {
    const question = byLabel.get(normalize(field.label));
    if (!question) return field;

    const selectField = question.fields.find((f) => f.values.length > 0);
    const options = selectField ? selectField.values.map((v) => v.label) : field.options;

    return { ...field, required: question.required, options };
  });
}

/**
 * Fetches Greenhouse's public Job Board API schema for `url` and merges it onto `fields`. Falls
 * through silently (returns `fields` unchanged) when `url` isn't a Greenhouse posting, the request
 * fails, or the response can't be parsed — the DOM-only pass already produced usable fields; this
 * only improves them when it can. Run from the background service worker (not the content script)
 * to avoid the page's own CSP/CORS restrictions.
 */
export async function enrichWithGreenhouseApi(
  url: string,
  fields: DetectedField[],
  fetchImpl: typeof fetch = fetch,
): Promise<DetectedField[]> {
  const info = parseGreenhouseUrl(url);
  if (!info) return fields;

  try {
    const res = await fetchImpl(greenhouseJobBoardApiUrl(info));
    if (!res.ok) return fields;

    const data = (await res.json()) as GreenhouseJobResponse;
    return mergeGreenhouseQuestions(fields, data);
  } catch {
    return fields;
  }
}

// ---------------------------------------------------------------------------------------------
// Ashby, SmartRecruiters, and Workable below follow the same parse/merge/enrich shape as
// Greenhouse above, but with lower confidence: research (`docs/ats-platform-detection.md`) could
// only reach an SPA shell for all three (no live-rendered DOM), and the exact API request/response
// shapes come from fetched documentation pages, not a confirmed live call. Each is built to fail
// safely — a wrong URL or unexpected response shape just falls through to the DOM-only fields
// already produced by `detectFields.ts`, never breaking the baseline. Verify each against a real
// posting before leaning on it.
// ---------------------------------------------------------------------------------------------

export interface AshbyUrlInfo {
  orgName: string;
  jobId: string;
}

/** Parses `jobs.ashbyhq.com/{orgName}/{jobId}`. Returns `null` for the job-board root (no job id). */
export function parseAshbyUrl(url: string): AshbyUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'jobs.ashbyhq.com') return null;

  const [orgName, jobId] = parsed.pathname.split('/').filter(Boolean);
  if (!orgName || !jobId) return null;

  return { orgName, jobId };
}

interface AshbyField {
  title: string;
  isRequired: boolean;
  selectableValues?: { label: string; value: string }[];
}

interface AshbyJobResponse {
  applicationFormDefinition: { sections: { fields: AshbyField[] }[] };
}

/** Merges Ashby's `applicationFormDefinition` field schema onto matching fields, by normalized label/title text. */
export function mergeAshbyQuestions(
  fields: DetectedField[],
  response: AshbyJobResponse,
): DetectedField[] {
  const allFields = response.applicationFormDefinition.sections.flatMap((s) => s.fields);
  const byTitle = new Map(allFields.map((f) => [normalize(f.title), f]));

  return fields.map((field) => {
    const match = byTitle.get(normalize(field.label));
    if (!match) return field;

    const options = match.selectableValues?.length
      ? match.selectableValues.map((v) => v.label)
      : field.options;

    return { ...field, required: match.isRequired, options };
  });
}

/**
 * UNVERIFIED endpoint shape — `docs/ats-platform-detection.md`'s Ashby section cites
 * `developers.ashbyhq.com/reference/jobpostinginfo` (a `jobPosting.info`-named reference) without
 * confirming the exact request method/auth live; this follows Ashby's documented posting-api
 * convention of POST-ing to a resource-scoped path with no request body. Confirm against a real
 * job posting (and check whether an API key is actually required) before trusting this.
 */
export function ashbyJobPostingApiUrl(info: AshbyUrlInfo): string {
  return `https://api.ashbyhq.com/posting-api/job-posting/${info.jobId}`;
}

/** Fetches Ashby's job posting API for `url` and merges it onto `fields`; falls through unchanged on any failure. See the UNVERIFIED note on {@link ashbyJobPostingApiUrl}. */
export async function enrichWithAshbyApi(
  url: string,
  fields: DetectedField[],
  fetchImpl: typeof fetch = fetch,
): Promise<DetectedField[]> {
  const info = parseAshbyUrl(url);
  if (!info) return fields;

  try {
    const res = await fetchImpl(ashbyJobPostingApiUrl(info), { method: 'POST' });
    if (!res.ok) return fields;

    const data = (await res.json()) as AshbyJobResponse;
    return mergeAshbyQuestions(fields, data);
  } catch {
    return fields;
  }
}

export interface SmartRecruitersUrlInfo {
  postingId: string;
}

/**
 * UNVERIFIED URL shape — research couldn't reach a live SmartRecruiters career-site posting page
 * (redirect-only), so this follows the commonly-seen `jobs.smartrecruiters.com/{Company}/{id}-{slug}`
 * pattern (a leading numeric/uuid posting id in the last path segment) without direct confirmation.
 */
export function parseSmartRecruitersUrl(url: string): SmartRecruitersUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!/(^|\.)smartrecruiters\.com$/.test(parsed.hostname)) return null;

  const lastSegment = parsed.pathname.split('/').filter(Boolean).at(-1);
  const match = lastSegment?.match(/^(\d+|[0-9a-f-]{8,})-/);
  if (!match) return null;

  return { postingId: match[1] };
}

interface SmartRecruitersField {
  type: string;
  required: boolean;
  values?: { id: string; label: string }[];
}

interface SmartRecruitersQuestion {
  label: string;
  fields: SmartRecruitersField[];
}

interface SmartRecruitersConfigurationResponse {
  questions: SmartRecruitersQuestion[];
}

/**
 * Merges SmartRecruiters' `/configuration` question schema onto matching fields, by normalized
 * label text. UNVERIFIED: `docs/ats-platform-detection.md` confirms `questions[].fields[]`'s shape
 * from SmartRecruiters' own docs, but doesn't confirm a `questions[].label` exists at the question
 * level (only the `fields[]` shape was directly cited) — this assumes one, matching the
 * Greenhouse/Ashby convention. Confirm against a real response before trusting.
 */
export function mergeSmartRecruitersQuestions(
  fields: DetectedField[],
  response: SmartRecruitersConfigurationResponse,
): DetectedField[] {
  const byLabel = new Map(response.questions.map((q) => [normalize(q.label), q]));

  return fields.map((field) => {
    const question = byLabel.get(normalize(field.label));
    if (!question) return field;

    const selectField = question.fields.find((f) => (f.values?.length ?? 0) > 0);
    const required = question.fields.some((f) => f.required);
    const options = selectField ? selectField.values!.map((v) => v.label) : field.options;

    return { ...field, required, options };
  });
}

/** `docs/ats-platform-detection.md`-cited endpoint: `GET /postings/{uuid}/configuration` on `api.smartrecruiters.com`. */
export function smartRecruitersConfigurationApiUrl(info: SmartRecruitersUrlInfo): string {
  return `https://api.smartrecruiters.com/v1/postings/${info.postingId}/configuration`;
}

/** Fetches SmartRecruiters' configuration API for `url` and merges it onto `fields`; falls through unchanged on any failure. */
export async function enrichWithSmartRecruitersApi(
  url: string,
  fields: DetectedField[],
  fetchImpl: typeof fetch = fetch,
): Promise<DetectedField[]> {
  const info = parseSmartRecruitersUrl(url);
  if (!info) return fields;

  try {
    const res = await fetchImpl(smartRecruitersConfigurationApiUrl(info));
    if (!res.ok) return fields;

    const data = (await res.json()) as SmartRecruitersConfigurationResponse;
    return mergeSmartRecruitersQuestions(fields, data);
  } catch {
    return fields;
  }
}

export interface WorkableUrlInfo {
  subdomain: string;
  shortcode: string;
}

/**
 * Parses a company-subdomain Workable URL (`{subdomain}.workable.com/j/{shortcode}` or
 * `/jobs/{shortcode}`). Returns `null` for the generic `apply.workable.com`/`jobs.workable.com`
 * hosts, which carry no company subdomain — without it, `workableApplicationFormApiUrl` can't be
 * constructed at all (the API is scoped to `{subdomain}.workable.com`).
 */
export function parseWorkableUrl(url: string): WorkableUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!parsed.hostname.endsWith('.workable.com')) return null;

  const subdomain = parsed.hostname.replace('.workable.com', '');
  if (['apply', 'jobs', 'www'].includes(subdomain)) return null;

  const match = parsed.pathname.match(/\/(?:j|jobs)\/([^/]+)/);
  if (!match) return null;

  return { subdomain, shortcode: match[1] };
}

interface WorkableQuestion {
  label: string;
  required: boolean;
  choices?: string[];
}

interface WorkableApplicationFormResponse {
  questions: WorkableQuestion[];
}

/**
 * Merges Workable's application-form question schema onto matching fields, by normalized label
 * text. UNVERIFIED: `docs/ats-platform-detection.md` couldn't confirm the exact field/enum names
 * (the reference doc URL 404'd during research) — `choices: string[]` is a best guess at how
 * option-bearing questions are shaped; confirm against a real response before trusting.
 */
export function mergeWorkableQuestions(
  fields: DetectedField[],
  response: WorkableApplicationFormResponse,
): DetectedField[] {
  const byLabel = new Map(response.questions.map((q) => [normalize(q.label), q]));

  return fields.map((field) => {
    const question = byLabel.get(normalize(field.label));
    if (!question) return field;

    const options = question.choices?.length ? question.choices : field.options;
    return { ...field, required: question.required, options };
  });
}

/** `docs/ats-platform-detection.md`-cited endpoint: `GET {subdomain}.workable.com/spi/v3/jobs/{shortcode}/application_form`. */
export function workableApplicationFormApiUrl(info: WorkableUrlInfo): string {
  return `https://${info.subdomain}.workable.com/spi/v3/jobs/${info.shortcode}/application_form`;
}

/** Fetches Workable's application-form API for `url` and merges it onto `fields`; falls through unchanged on any failure. */
export async function enrichWithWorkableApi(
  url: string,
  fields: DetectedField[],
  fetchImpl: typeof fetch = fetch,
): Promise<DetectedField[]> {
  const info = parseWorkableUrl(url);
  if (!info) return fields;

  try {
    const res = await fetchImpl(workableApplicationFormApiUrl(info));
    if (!res.ok) return fields;

    const data = (await res.json()) as WorkableApplicationFormResponse;
    return mergeWorkableQuestions(fields, data);
  } catch {
    return fields;
  }
}

/**
 * Tries each platform's API oracle in turn (Greenhouse first — the only one with a confirmed-live
 * request/response shape), based on which one recognizes `url`. Returns `fields` unchanged if none
 * do, or if the matching one fails — see each `enrichWith*Api` for its own safe-fallback behavior.
 */
export async function enrichWithApiOracle(
  url: string,
  fields: DetectedField[],
  fetchImpl: typeof fetch = fetch,
): Promise<DetectedField[]> {
  if (parseGreenhouseUrl(url)) return enrichWithGreenhouseApi(url, fields, fetchImpl);
  if (parseAshbyUrl(url)) return enrichWithAshbyApi(url, fields, fetchImpl);
  if (parseSmartRecruitersUrl(url)) return enrichWithSmartRecruitersApi(url, fields, fetchImpl);
  if (parseWorkableUrl(url)) return enrichWithWorkableApi(url, fields, fetchImpl);
  return fields;
}
