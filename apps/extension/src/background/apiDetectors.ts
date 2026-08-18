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
   *
   * A plain GET. This carried an `init?: RequestInit` for a while, used by exactly one adapter —
   * the Ashby one, which never worked; see the note further down. Reinstate it when a platform that
   * actually answers needs a POST, not before.
   */
  request(url: string): { url: string } | null;
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

/**
 * Subdomains that name the *page's role* rather than the company, so they can't be a Board Token.
 *
 * Only consulted by {@link whiteLabelBoardToken}, where the company name is being guessed from the host.
 * Incomplete by nature — there is no closed set of words a company might put in front of its own
 * name — which is why a miss has to stay cheap rather than be prevented.
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
 * A Board Token guessed from a company's own careers hostname — `www.brex.com` → `brex`.
 *
 * A guess, and deliberately so. Greenhouse lets a company white-label its board onto its own domain
 * (`www.brex.com/careers/8459783002?gh_jid=8459783002`), and at that point the URL carries the job
 * id but not the board token the Job Board API is keyed by. The company's own domain label is the
 * token far more often than not, and a wrong guess costs exactly one 404 that
 * {@link enrichWithApiOracle} already treats as "no enrichment" — versus the status quo, where a
 * white-labeled posting reached no oracle at all and every one of its comboboxes stayed
 * choice-less, because Greenhouse mounts its option lists in a portal that isn't in the DOM until
 * the dropdown is opened.
 *
 * The first non-generic label rather than the registrable domain, which needs a public-suffix list
 * to find: `careers.acme.co.uk` reads as `acme` here and as `co` from the right-hand end. The two
 * rules fail on opposite inputs (this one on an unlisted subdomain like `emea.acme.com`) and neither
 * dominates; this one is at least wrong in a way a reader can see from {@link GENERIC_SUBDOMAINS}.
 */
function whiteLabelBoardToken(hostname: string): string | null {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  const named = labels.find((label) => !GENERIC_SUBDOMAINS.has(label));
  // A bare TLD is not a company name: `www.com` would otherwise yield the board token `com`.
  return named && named !== labels.at(-1) ? named : null;
}

/** A Greenhouse Posting Id — always numeric, and validated as such before it reaches a request URL. */
function asPostingId(value: string | null): string | null {
  return value && /^\d+$/.test(value) ? value : null;
}

/**
 * The Board Token and Posting Id `url` names, or `null` if it names no Greenhouse posting.
 *
 * Board and id are resolved together because which of them is authoritative depends on the same
 * question — is this Greenhouse's own host, or a company's? On `greenhouse.io` the path states both.
 * Off it, only the `gh_jid` parameter does, and reading the path there is actively wrong: the
 * company's own routing may well spell `/en/jobs/482`, whose `482` would be taken for the posting id
 * over the `gh_jid` that actually identifies it.
 */
function greenhousePosting(url: URL): { boardToken: string; postingId: string } | null {
  if (/(^|\.)greenhouse\.io$/.test(url.hostname)) {
    // Covers both `job-boards.greenhouse.io/{board}/jobs/{id}` and the legacy `boards.` host.
    const path = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (path) return { boardToken: path[1], postingId: path[2] };

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

    // The token is escaped and the id is already validated as digits by `asPostingId`, so neither can
    // reshape the request's path or query — the guarantee the old `\d+`-anchored path match gave for
    // free, and which is worth keeping now that both can come from arbitrary query parameters.
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
// SmartRecruiters and Workable below are UNVERIFIED: research (`docs/ats-platform-detection.md`)
// could only reach an SPA shell for both, so their request and response shapes come from
// documentation rather than a confirmed live call. Each still fails safely — a wrong URL or
// unexpected shape falls through to the DOM-scraped fields — but confirm one against a real posting
// before relying on it.
//
// There is no Ashby oracle. One existed and was removed: it called
// `POST https://api.ashbyhq.com/posting-api/job-posting/{jobId}`, which returns **401**, so it never
// enriched a single field in its life. Because `enrichWithApiOracle` falls through silently on a bad
// response, that was indistinguishable from "no oracle recognized this host" — and its tests passed
// throughout, because they asserted the dead endpoint and a response shape Ashby serves nowhere.
//
// Two dead ends, recorded so they aren't retried:
//   - `developers.ashbyhq.com/reference/jobpostinginfo` is the *employer* API: BasicAuth, requires
//     the `jobsRead` permission. Unusable from an extension.
//   - The public board API `GET https://api.ashbyhq.com/posting-api/job-board/{org}` returns 200 but
//     carries listing data only — no application form schema at any public path.
//
// The one source that does work, verified live against a real posting:
//
//   POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting
//   jobPosting(organizationHostedJobsPageName: $orgName, jobPostingId: $jobId) {
//     applicationForm { sections { title fieldEntries { field isRequired } } }
//   }
//
// Unauthenticated, and richer than any other platform's. Note the shape is
// `applicationForm.sections[].fieldEntries[].field` with `isRequired` on the **entry**. Building it
// also needs `https://jobs.ashbyhq.com/*` in `manifest.ts`'s `host_permissions`, and a POST body —
// which is why `AtsOracle.request` would need to return an `init` again (see its doc comment).
// Caveat: that endpoint is an internal API with no compatibility guarantee.
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

/**
 * Re-applies the enrichment an earlier scan received to the fields a later scan produced.
 *
 * The Fill Step re-scans the page so it fills what's there *now* rather than what was there when the
 * Analysis Step ran. But that re-scan comes back through `SCAN_PAGE`, which never passes an oracle —
 * enrichment only ever attached on the `REPORT_JOB_PAGE` path. Preferring the fresh scan therefore
 * threw the enrichment away, and the failure was total rather than partial: a Question Answer is
 * drafted against, and constrained to, the API's wording of the choices, so filling it against the
 * DOM's wording missed on the strict match *and* on the label fallback, and the field came back
 * reported as an unresolved required field. Enriched `required` flags were dropped the same way.
 *
 * Carrying rather than re-fetching is the point: the answers were drafted against `analyzed`'s
 * labels, so `analyzed` is by definition the right thing to match them against. A second oracle call
 * would cost a round trip during the fill to reproduce what we already hold.
 *
 * This is {@link applyPatches} with the earlier scan standing in for the oracle, so the wording/
 * selector trade is made in exactly one place rather than described twice.
 *
 * **Where a selector survives, and where it can't.** When the API and the DOM word a choice the same
 * way, the fresh scan's selector is carried and the Fill Step can click the element. When they word
 * it differently, the carried option has no selector — but nothing was lost in the carrying: the
 * analyzed option had no selector *either*, because {@link mergeOptions} already failed to pair the
 * two wordings back at enrichment time. That field is unfillable from the moment the oracle
 * disagreed with the page, which is a hole in enrichment itself and not in this function.
 * {@link warnOnUnpairedOptions} exists so it stops being a silent one.
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
 * Reports a field whose carried options all lost their selector while the fresh scan had one.
 *
 * That is the signature of the API and the page wording the same choice differently: every option
 * now carries text the DOM never renders, so the answer drafted against it will match no element and
 * the field will be reported unresolved. It looks identical to success from here — the fields come
 * back enriched, just unclickable — which is the failure shape this module keeps producing.
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
      const res = await fetchImpl(request.url);
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
