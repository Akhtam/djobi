import { normalizeLabel, type DetectedField, type FieldOption } from '@djobi/shared';

/**
 * Platform API oracles: given a job posting URL, fetch that ATS's own published schema for the form
 * and use it to improve the fields `content/detectFields.ts` scraped from the DOM.
 *
 * The DOM pass is always the baseline. An oracle only ever adds confidence — chiefly `required`
 * flags, and the choices for a combobox whose listbox isn't in the page at load time — and every
 * failure path (unrecognized URL, network error, unexpected response shape) falls through to the
 * scraped fields unchanged, so a wrong guess degrades rather than breaks.
 *
 * Each platform is an {@link AtsOracle} adapter answering three questions: is this URL mine, where
 * is the schema, and what does that schema say about these questions. Everything else — the fetch,
 * the error handling, matching questions to fields by label, and merging choices without discarding
 * the DOM selectors that make them clickable — lives once, below.
 */

/** What an ATS's schema says about one question, projected into a platform-independent shape. */
interface QuestionPatch {
  /** Left undefined when the schema doesn't say, so the DOM's own determination stands. */
  required?: boolean;
  /** Authoritative choice labels, if the schema lists any. */
  optionLabels?: string[];
}

export interface AtsOracle {
  /** Platform name, for diagnostics. */
  readonly name: string;
  /**
   * The schema request for `url`, or `null` if this platform doesn't recognize it. Returning `null`
   * is how URL parsing reports "not mine", so a posting only ever reaches one oracle.
   */
  request(url: string): { url: string; init?: RequestInit } | null;
  /** Projects a parsed schema response into patches keyed by normalized question label. */
  patches(response: unknown): Map<string, QuestionPatch>;
}

/** Parses `url`, returning `null` for anything malformed so each oracle needn't repeat the try/catch. */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Overlays an ATS API's authoritative choice labels onto the ones `detectFields.ts` scraped,
 * **keeping the DOM selector** recorded for any choice we already saw. Replacing the scraped options
 * outright would trade a choice the Fill Step can click for a label string it can only try to
 * text-match — and the API's wording doesn't always match what the page renders, so that trade can
 * silently make a field unfillable. Choices the API knows about but the DOM didn't (a listbox that
 * only mounts when opened) get `selector: null` and fall back to label matching.
 */
function mergeOptions(existing: FieldOption[] | undefined, apiLabels: string[]): FieldOption[] {
  const selectorByLabel = new Map(
    (existing ?? []).map((option) => [normalizeLabel(option.label), option.selector]),
  );

  return apiLabels.map((label) => ({
    label,
    selector: selectorByLabel.get(normalizeLabel(label)) ?? null,
  }));
}

/**
 * Applies `patches` to the fields whose label matches, by normalized label text — not by DOM id. A
 * react-select combobox's id is an internal generated one, not the API's stable field name, but its
 * accessible label is the same string a candidate reads either way. Fields with no matching question
 * are returned untouched.
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

const greenhouse: AtsOracle = {
  name: 'Greenhouse',

  request(url) {
    const parsed = parseUrl(url);
    if (!parsed || !/(^|\.)greenhouse\.io$/.test(parsed.hostname)) return null;

    // Covers both `job-boards.greenhouse.io/{board}/jobs/{id}` and the legacy `boards.` host.
    const match = parsed.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (!match) return null;

    return {
      url: `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs/${match[2]}?questions=true`,
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
// SmartRecruiters and Workable below are UNVERIFIED: research (`docs/ats-platform-detection.md`)
// could only reach an SPA shell for both, so their request and response shapes come from
// documentation rather than a confirmed live call. Each still fails safely — a wrong URL or
// unexpected shape falls through to the DOM-scraped fields — but confirm one against a real posting
// before relying on it.
//
// Ashby is worse than unverified: it is confirmed DEAD. See the oracle below.
// ----------------------------------------------------------------------------------------------

interface AshbyResponse {
  applicationFormDefinition: {
    sections: {
      fields: { title: string; isRequired: boolean; selectableValues?: { label: string }[] }[];
    }[];
  };
}

/**
 * **DEAD — this oracle has never enriched a single field. TODO: rewrite per the notes below.**
 *
 * The endpoint it calls returns **401**, confirmed live:
 * `POST https://api.ashbyhq.com/posting-api/job-posting/{jobId}` → 401. `enrichWithApiOracle`'s
 * `if (!res.ok) return fields` then silently hands back the DOM-scraped fields, which is
 * indistinguishable from "no oracle matched this host" — which is why this went unnoticed.
 *
 * Two dead ends, so they aren't re-tried:
 *
 * - `developers.ashbyhq.com/reference/jobpostinginfo` (which {@link AshbyResponse} was modelled on)
 *   is the **employer** API: `POST https://api.ashbyhq.com/jobPosting.info`, BasicAuth, requires the
 *   `jobsRead` permission. Unusable from an extension.
 * - The unauthenticated public board API `GET https://api.ashbyhq.com/posting-api/job-board/{org}`
 *   does return 200, but carries listing data only (`title`, `location`, `descriptionHtml`, …) and
 *   **no `applicationFormDefinition`**. So {@link AshbyResponse} matches nothing Ashby serves
 *   publicly at any path.
 *
 * The one source of the form schema that does work, verified live against a real posting:
 *
 * ```
 * POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting
 * jobPosting(organizationHostedJobsPageName: $orgName, jobPostingId: $jobId) {
 *   applicationForm { sections { title fieldEntries { field isRequired } } }
 * }
 * ```
 *
 * Unauthenticated, and richer than any other platform's — every field's `type`, `isRequired` and
 * `selectableValues`. Note the shape is `applicationForm.sections[].fieldEntries[].field` with
 * `isRequired` on the **entry**, not `applicationFormDefinition.sections[].fields[]` with
 * `isRequired` on the field. `parseUrl` below already yields the `orgName` the query needs as
 * `organizationHostedJobsPageName`.
 *
 * Rewriting this also needs `https://jobs.ashbyhq.com/*` added to `manifest.ts`'s
 * `host_permissions` — the current list only covers `api.ashbyhq.com`.
 *
 * Caveat worth carrying: that endpoint is an internal API. It is unauthenticated today and
 * introspection is disabled, but it carries no compatibility guarantee and may change without
 * notice.
 */
const ashby: AtsOracle = {
  name: 'Ashby',

  request(url) {
    const parsed = parseUrl(url);
    if (!parsed || parsed.hostname !== 'jobs.ashbyhq.com') return null;

    const [orgName, jobId] = parsed.pathname.split('/').filter(Boolean);
    if (!orgName || !jobId) return null; // the job-board root, not a specific posting

    // Follows Ashby's documented posting-api convention: POST to a resource-scoped path, no body.
    // This 401s — see the note above; kept only so the rewrite has something to replace.
    return {
      url: `https://api.ashbyhq.com/posting-api/job-posting/${jobId}`,
      init: { method: 'POST' },
    };
  },

  patches(response) {
    const fields = (response as AshbyResponse).applicationFormDefinition.sections.flatMap(
      (section) => section.fields,
    );

    return new Map(
      fields.map((field) => [
        normalizeLabel(field.title),
        {
          required: field.isRequired,
          optionLabels: field.selectableValues?.map((value) => value.label),
        },
      ]),
    );
  },
};

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
          // Undefined rather than `false` when a question carries no fields: `applyPatches` then
          // keeps whatever the DOM determined, instead of overwriting a correct `required` with a
          // guess derived from an empty list.
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

    // The API is scoped to a company subdomain, so the generic hosts can't be addressed at all.
    const subdomain = parsed.hostname.replace('.workable.com', '');
    if (['apply', 'jobs', 'www'].includes(subdomain)) return null;

    const match = parsed.pathname.match(/\/(?:j|jobs)\/([^/]+)/);
    if (!match) return null;

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

/** Greenhouse first — the one confirmed live. A given URL only ever matches one of these. */
const ORACLES: readonly AtsOracle[] = [greenhouse, ashby, smartRecruiters, workable];

/**
 * Improves `fields` using whichever platform recognizes `url`, or returns them unchanged when none
 * does, or the fetch or parse fails. Run from the background service worker rather than the content
 * script, so the page's own CSP and CORS rules don't apply.
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
      const res = await fetchImpl(request.url, request.init);
      if (!res.ok) {
        console.warn(`[djobi] ${oracle.name} oracle: schema request failed (${res.status})`);
        return fields;
      }

      const patches = oracle.patches(await res.json());
      const { fields: patched, matched } = applyPatches(fields, patches);

      // An oracle that answered with questions none of which matched a detected field is the one
      // failure here that looks exactly like success: the fields come back unchanged, same as if no
      // oracle had recognized the URL at all. It means the two sides word the same question
      // differently (the match is by normalized label text), and the enrichment silently did
      // nothing. Say so, because the alternative is finding out from an unfillable form.
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
