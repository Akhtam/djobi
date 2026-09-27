import {
  labelsMatch,
  normalizeLabel,
  uniqueMatch,
  type DetectedField,
  type FieldOption,
} from '@djobi/shared';

/**
 * Platform API oracles: fetch an ATS's published form schema for a posting URL and use it to
 * improve the fields `content/detectFields.ts` scraped — chiefly `required` flags and the choices
 * of comboboxes whose listbox isn't mounted at load.
 *
 * The DOM scan is always the baseline; every failure (unknown URL, network error, odd shape) falls
 * back to it unchanged. Each platform is an {@link AtsOracle}; fetching, label matching and option
 * merging live once below.
 */

/** What an ATS's schema says about one question, projected into a platform-independent shape. */
interface QuestionPatch {
  /** Left undefined when the schema doesn't say, so the DOM's own determination stands. */
  required?: boolean | undefined;
  /** Authoritative choice labels, if the schema lists any. */
  optionLabels?: string[] | undefined;
}

export interface AtsOracle {
  /** Platform name, for diagnostics. */
  readonly name: string;
  /**
   * The schema request for `url`, or `null` if this platform doesn't recognize it. A plain GET; add
   * a request `init` only when a working platform needs a POST.
   */
  request(url: string): { url: string } | null;
  /** Projects a parsed schema response into patches keyed by normalized question label. */
  patches(response: unknown): Map<string, QuestionPatch>;
}

/**
 * Parses `url`, returning `null` for anything malformed so each oracle needn't repeat the
 * try/catch.
 */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Overlays the API's choice labels onto the scraped ones, **keeping the DOM selector** for choices
 * the page already showed (the API's wording may differ from the page's). Choices only the API
 * knows get `selector: null` and fall back to label matching.
 */
function mergeOptions(existing: FieldOption[] | undefined, apiLabels: string[]): FieldOption[] {
  return apiLabels.map((label) => {
    const match = uniqueMatch(existing ?? [], (option) => labelsMatch(option.label, label));
    return { label, selector: match?.selector ?? null };
  });
}

/**
 * Applies `patches` to fields whose normalized label matches — not by DOM id, which for comboboxes
 * is generated. Unmatched fields are returned untouched.
 */
function applyPatches(
  fields: DetectedField[],
  patches: Map<string, QuestionPatch>,
): { fields: DetectedField[]; matched: number } {
  let matched = 0;

  const patched = fields.map((field) => {
    const patch = patches.get(normalizeLabel(field.label));
    if (!patch) return field;
    matched++;

    return {
      ...field,
      required: patch.required ?? field.required,
      options: patch.optionLabels?.length
        ? mergeOptions(field.options, patch.optionLabels)
        : field.options,
    };
  });

  return { fields: patched, matched };
}

// --- Greenhouse -------------------------------------------------------------------------------
// The only platform whose request/response shape is confirmed against a live posting.

interface GreenhouseResponse {
  questions: {
    label: string;
    required: boolean;
    fields: { name: string; type: string; values: { value: string; label: string }[] }[];
  }[];
}

/**
 * Subdomains naming the page's role rather than the company, so never a Board Token. Necessarily
 * incomplete; a miss only costs one 404.
 */
const GENERIC_SUBDOMAINS = new Set([
  'www',
  'careers',
  'career',
  'jobs',
  'job',
  'boards',
  'apply',
  'work',
  'talent',
  'hire',
  'hiring',
  'recruiting',
  'recruitment',
  'join',
  'people',
  'life',
  'about',
]);

/**
 * A Board Token guessed from a white-labeled careers host (`www.brex.com` → `brex`), where the URL
 * carries `gh_jid` but not the token. Usually right; a wrong guess is one 404 that
 * {@link enrichWithApiOracle} treats as "no enrichment".
 *
 * Takes the first non-generic label rather than the registrable domain (which needs a public-suffix
 * list); its failures are visible in {@link GENERIC_SUBDOMAINS}.
 */
function whiteLabelBoardToken(hostname: string): string | null {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  const named = labels.find((label) => !GENERIC_SUBDOMAINS.has(label));
  // A bare TLD is not a company name: `www.com` would otherwise yield the board token `com`.
  return named && named !== labels.at(-1) ? named : null;
}

/**
 * A Greenhouse Posting Id — always numeric, and validated as such before it reaches a request URL.
 */
function asPostingId(value: string | null): string | null {
  return value && /^\d+$/.test(value) ? value : null;
}

/**
 * The Board Token and Posting Id `url` names, or `null`. On `greenhouse.io` the path states both;
 * elsewhere only `gh_jid` is trusted — a company's own path (`/en/jobs/482`) is not a posting id.
 */
function greenhousePosting(url: URL): { boardToken: string; postingId: string } | null {
  if (/(^|\.)greenhouse\.io$/.test(url.hostname)) {
    // Covers both `job-boards.greenhouse.io/{board}/jobs/{id}` and the legacy `boards.` host.
    const path = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (path?.[1] && path[2]) return { boardToken: path[1], postingId: path[2] };

    // The `job_app`/`job_board` embed iframes, which name both outright as parameters.
    const boardToken = url.searchParams.get('for');
    const postingId = asPostingId(url.searchParams.get('token') ?? url.searchParams.get('gh_jid'));
    return boardToken && postingId ? { boardToken, postingId } : null;
  }

  // A company's own domain only counts as a Greenhouse board when the URL says it is one.
  const postingId = asPostingId(url.searchParams.get('gh_jid'));
  if (!postingId) return null;

  const boardToken = whiteLabelBoardToken(url.hostname);
  return boardToken ? { boardToken, postingId } : null;
}

const greenhouse: AtsOracle = {
  name: 'Greenhouse',

  request(url) {
    const parsed = parseUrl(url);
    if (!parsed) return null;

    const posting = greenhousePosting(parsed);
    if (!posting) return null;

    // The token is escaped and the id is digits-only, so neither can reshape the request URL.
    return {
      url:
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(posting.boardToken)}` +
        `/jobs/${posting.postingId}?questions=true`,
    };
  },

  patches(response) {
    return new Map(
      (response as GreenhouseResponse).questions.map((question) => [
        normalizeLabel(question.label),
        {
          required: question.required,
          optionLabels: question.fields
            .find((field) => field.values.length > 0)
            ?.values.map((value) => value.label),
        },
      ]),
    );
  },
};

// ----------------------------------------------------------------------------------------------
// SmartRecruiters and Workable are UNVERIFIED: their shapes come from documentation, not a live
// call (see `docs/ats-platform-detection.md`). Both fail safe; confirm against a real posting
// before relying on them.
//
// No Ashby oracle: its public posting API returns 401 and the board API has no form schema. The
// one working source is the internal, unguaranteed
//   POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting
//   jobPosting(organizationHostedJobsPageName, jobPostingId) {
//     applicationForm { sections { fieldEntries { field isRequired } } }
//   }
// which would need a POST `init` on `AtsOracle.request` and `https://jobs.ashbyhq.com/*` in
// `manifest.ts`'s `host_permissions`.
// ----------------------------------------------------------------------------------------------

interface SmartRecruitersResponse {
  questions: {
    label: string;
    fields: { type: string; required: boolean; values?: { id: string; label: string }[] }[];
  }[];
}

const smartRecruiters: AtsOracle = {
  name: 'SmartRecruiters',

  request(url) {
    const parsed = parseUrl(url);
    if (!parsed || !/(^|\.)smartrecruiters\.com$/.test(parsed.hostname)) return null;

    // The commonly-seen `jobs.smartrecruiters.com/{Company}/{id}-{slug}` shape.
    const match = parsed.pathname
      .split('/')
      .filter(Boolean)
      .at(-1)
      ?.match(/^(\d+|[0-9a-f-]{8,})-/);
    if (!match) return null;

    return { url: `https://api.smartrecruiters.com/v1/postings/${match[1]}/configuration` };
  },

  patches(response) {
    return new Map(
      (response as SmartRecruitersResponse).questions.map((question) => [
        normalizeLabel(question.label),
        {
          // `undefined` for a question with no fields, so the DOM's `required` is kept.
          required: question.fields.length
            ? question.fields.some((field) => field.required)
            : undefined,
          optionLabels: question.fields
            .find((field) => (field.values?.length ?? 0) > 0)
            ?.values?.map((value) => value.label),
        },
      ]),
    );
  },
};

interface WorkableResponse {
  questions: { label: string; required: boolean; choices?: string[] }[];
}

const workable: AtsOracle = {
  name: 'Workable',

  request(url) {
    const parsed = parseUrl(url);
    if (!parsed || !parsed.hostname.endsWith('.workable.com')) return null;

    // Slice the suffix off the end: `String.replace` would remove the first occurrence and, for
    // `a.workable.com.b.workable.com`, yield the wrong subdomain.
    const subdomain = parsed.hostname.slice(0, -'.workable.com'.length);
    // The API is scoped to a company subdomain, so the generic hosts can't be addressed at all.
    if (['apply', 'jobs', 'www'].includes(subdomain)) return null;

    const match = parsed.pathname.match(/\/(?:j|jobs)\/([^/]+)/);
    if (!match) return null;

    // Not re-encoded: `URL.pathname` already encoded this single segment, and `[^/]+` plus URL
    // parsing rule out separators and `..`.
    return { url: `https://${subdomain}.workable.com/spi/v3/jobs/${match[1]}/application_form` };
  },

  patches(response) {
    return new Map(
      (response as WorkableResponse).questions.map((question) => [
        normalizeLabel(question.label),
        { required: question.required, optionLabels: question.choices },
      ]),
    );
  },
};

/**
 * Re-applies an earlier scan's enrichment to a later scan's fields.
 *
 * The Fill Step's re-scan (`SCAN_PAGE`) never passes an oracle, and answers were drafted against
 * the analyzed run's (API) wording — so the fresh fields take their elements from the new scan and
 * their wording and `required` flags from `analyzed`, via {@link applyPatches}. Carrying beats
 * re-fetching: `analyzed` is by definition what the answers match.
 *
 * Where API and DOM wording differ, the carried option has no selector — but it never had one
 * ({@link mergeOptions} couldn't pair them either). {@link warnOnUnpairedOptions} reports that.
 */
export function carryEnrichment(
  scanned: DetectedField[],
  analyzed: readonly DetectedField[],
): DetectedField[] {
  const patches = new Map(
    analyzed
      .filter((field) => field.label)
      .map((field) => [
        normalizeLabel(field.label),
        {
          // `undefined` rather than `false`, so `applyPatches`' `??` leaves a `required` the fresh
          // DOM asserts on its own standing. An oracle raises the flag; carrying never lowers it.
          required: field.required || undefined,
          optionLabels: field.options?.map((option) => option.label),
        },
      ]),
  );

  const carried = applyPatches(scanned, patches).fields;
  warnOnUnpairedOptions(scanned, carried);
  return carried;
}

/**
 * Warns when a field's carried options all lost their selector while the fresh scan had them — API
 * and page wording disagree, so the field will come back unresolved rather than failing loudly.
 */
function warnOnUnpairedOptions(scanned: DetectedField[], carried: DetectedField[]): void {
  carried.forEach((field, index) => {
    const before = scanned[index]?.options;
    if (!before?.some((option) => option.selector)) return;
    if (!field.options?.length || field.options.some((option) => option.selector)) return;

    console.warn(
      `[djobi] "${field.label}": the ATS API words every choice differently from the page, so none ` +
        `could be paired back to an element — this field will not fill`,
    );
  });
}

/** Greenhouse first — the one confirmed live. A given URL only ever matches one of these. */
const ORACLES: readonly AtsOracle[] = [greenhouse, smartRecruiters, workable];

/**
 * Improves `fields` with whichever platform recognizes `url`; unchanged if none does or anything
 * fails. Runs in the service worker so the page's CSP and CORS don't apply.
 */
export async function enrichWithApiOracle(
  url: string,
  fields: DetectedField[],
  fetchImpl: typeof fetch = fetch,
): Promise<DetectedField[]> {
  for (const oracle of ORACLES) {
    const request = oracle.request(url);
    if (!request) continue;

    try {
      const res = await fetchImpl(request.url);
      if (!res.ok) {
        console.warn(`[djobi] ${oracle.name} oracle: schema request failed (${res.status})`);
        return fields;
      }

      const patches = oracle.patches(await res.json());
      const { fields: patched, matched } = applyPatches(fields, patches);

      // Questions came back but none matched a field: the two sides word them differently, and
      // silently doing nothing would look like success. Warn.
      if (patches.size > 0 && matched === 0) {
        console.warn(
          `[djobi] ${oracle.name} oracle: ${patches.size} question(s) in the schema matched none of ` +
            `the ${fields.length} detected field(s) by label — enrichment had no effect`,
        );
      }

      return patched;
    } catch {
      return fields;
    }
  }

  return fields;
}
