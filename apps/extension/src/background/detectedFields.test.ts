/**
 * The Detected Field lifecycle at its own interface: report, enrich, snapshot.
 *
 * These cases are all about *ordering*, which is what the lifecycle was missing when it was spread
 * across the router, the store, the oracle and the pipeline. Each module was individually correct;
 * what nobody owned was the fact that a run started before an oracle answers must wait for it.
 *
 * `fetch` is stubbed globally rather than injected, because the point of every case is what happens
 * when `recordReport` is called the way the router calls it — with no way to pass an adapter in.
 */
import type { DetectedField } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from '../lib/fakeChrome';
import { getDetectedPage } from '../lib/tabStore/detectedPage';
import { frameForFill, recordReport, snapshotForRun } from './detectedFields';

/** A Greenhouse posting, which the oracle recognizes and will fetch a schema for. */
const POSTING = 'https://boards.greenhouse.io/acme/jobs/1';

const QUESTION = 'Are you authorized to work in the US?';

/** What the Greenhouse Job Board API answers with — a required question and its two choices. */
const SCHEMA = {
  questions: [
    {
      label: QUESTION,
      required: true,
      fields: [
        {
          name: 'work_auth',
          type: 'multi_value_single_select',
          values: [
            { value: '1', label: 'Yes, I am authorized' },
            { value: '0', label: 'No, I require sponsorship' },
          ],
        },
      ],
    },
  ],
};

function question(label = QUESTION): DetectedField {
  return {
    id: 'q1',
    label,
    inputType: 'text',
    selector: '#q1',
    category: 'question',
    required: false,
    elementRole: 'combobox',
  };
}

/** A `fetch` whose response the test releases by hand, so a snapshot can be taken mid-flight. */
function gatedFetch(body: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const fetchImpl = vi.fn(async () => {
    await gate;
    return { ok: true, json: async () => body } as unknown as Response;
  });

  return { fetchImpl, release };
}

describe('detectedFields', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeChrome();
  });

  it('holds the run snapshot until an enrichment already in flight lands', async () => {
    // The bug this module exists for. Analysis read the frame store the moment the candidate
    // clicked, so clicking before the oracle answered analyzed DOM-only fields: the questions
    // crossing to the backend carried the page's wording of the choices rather than the API's, and
    // the answers drafted from them matched no element at fill time.
    const { fetchImpl, release } = gatedFetch(SCHEMA);
    vi.stubGlobal('fetch', fetchImpl);

    const reported = recordReport(1, 0, [question()], POSTING);
    // The baseline is stored and readable straight away — enrichment only ever adds to it.
    await vi.waitFor(() => expect(getDetectedPage(1)).resolves.not.toBeNull());

    const snapshot = snapshotForRun(1);
    release();
    const fields = (await snapshot).fields;
    await reported;

    expect(fields[0]!.required).toBe(true);
    expect(fields[0]!.options?.map((option) => option.label)).toEqual([
      'Yes, I am authorized',
      'No, I require sponsorship',
    ]);
  });

  it('holds the snapshot for a report that arrives while it is already waiting on an earlier one', async () => {
    // A form mounts in pieces and the content script re-reports as it does, so a report can be
    // registered *while* the snapshot is already waiting. Racing one snapshot of the registry
    // returned as soon as the first report settled, with the re-report's own oracle call still
    // outstanding — and the run was analyzed against DOM-only wording for exactly the fields the
    // re-report had just replaced, which is the failure this whole module exists to prevent.
    const partial = gatedFetch(SCHEMA);
    vi.stubGlobal('fetch', partial.fetchImpl);
    const firstReport = recordReport(1, 0, [question()], POSTING);
    await vi.waitFor(() => expect(getDetectedPage(1)).resolves.not.toBeNull());

    let taken = false;
    const snapshot = snapshotForRun(1, 1_000).then((page) => {
      taken = true;
      return page;
    });

    // The rest of the form mounts and the frame reports again, mid-wait.
    const complete = gatedFetch(SCHEMA);
    vi.stubGlobal('fetch', complete.fetchImpl);
    const secondReport = recordReport(1, 0, [question()], POSTING);

    partial.release();
    await firstReport;
    // The first report has fully settled and the second has not. A wait that raced one snapshot of
    // the registry returns here; this one must still be holding.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(taken).toBe(false);

    complete.release();
    const fields = (await snapshot).fields;
    await secondReport;

    expect(fields[0]!.required).toBe(true);
  });

  it('proceeds on baseline fields when the oracle never answers, rather than hanging Analyze', async () => {
    // `enrichWithApiOracle` has no timeout of its own, so an ATS host that accepts the connection
    // and then stalls would otherwise trade a degraded analysis for no analysis at all.
    const { fetchImpl, release } = gatedFetch(SCHEMA);
    vi.stubGlobal('fetch', fetchImpl);

    const reported = recordReport(1, 0, [question()], POSTING);
    await vi.waitFor(() => expect(getDetectedPage(1)).resolves.not.toBeNull());

    const fields = (await snapshotForRun(1, 10)).fields;

    expect(fields[0]!.required).toBe(false);
    expect(fields[0]!.options).toBeUndefined();

    release();
    await reported;
  });

  it('waits for nothing once the enrichment has settled, so a later run pays no timeout', async () => {
    // The in-flight registry is in memory and must empty itself however a call ends; a leak here
    // would make every subsequent Analysis Step on the tab wait out the full timeout.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => SCHEMA } as unknown as Response),
    );
    await recordReport(1, 0, [question()], POSTING);

    // A timeout of zero can only pass if there is nothing left registered to wait on.
    const fields = (await snapshotForRun(1, 0)).fields;

    expect(fields[0]!.required).toBe(true);
  });

  it('leaves the snapshot to the baseline when the oracle fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await recordReport(1, 0, [question()], POSTING);

    expect((await snapshotForRun(1, 0)).fields[0]!.required).toBe(false);
  });

  it('still drops a stale enrichment whose frame was re-reported while it was in flight', async () => {
    // The revision guard lives in `lib/tabStore/detectedPage.ts` and is not bypassed by routing
    // reports through here: a slow response for a page the tab has navigated away from must not
    // land on fresher detection, even though this module now waits for responses rather than firing
    // and forgetting.
    const { fetchImpl, release } = gatedFetch(SCHEMA);
    vi.stubGlobal('fetch', fetchImpl);

    const stale = recordReport(1, 0, [question()], POSTING);
    await vi.waitFor(() => expect(getDetectedPage(1)).resolves.not.toBeNull());
    await recordReport(1, 0, [question('A different question entirely')], undefined);

    release();
    await stale;

    const fields = (await snapshotForRun(1, 0)).fields;
    expect(fields[0]!.label).toBe('A different question entirely');
    expect(fields[0]!.required).toBe(false);
  });

  it('reports no form for a tab nothing has detected on, rather than a missing one', async () => {
    // A run analyzed from a pasted Job Description before the form rendered is a normal run.
    expect(await snapshotForRun(999, 0)).toEqual({ fields: [] });
    expect(await frameForFill(999)).toBeNull();
  });

  it('addresses the frame that detected the most fields, without waiting on enrichment', async () => {
    // The Fill Step re-scans the live page and carries wording forward from the run it is filling,
    // so all it needs from the store is which frame to talk to — settled by the report itself.
    const { fetchImpl, release } = gatedFetch(SCHEMA);
    vi.stubGlobal('fetch', fetchImpl);

    await recordReport(1, 0, [question()], undefined);
    const pending = recordReport(1, 3, [question('a'), question('b')], POSTING);

    // The report itself is stored before the oracle is called, so this resolves while the gated
    // fetch above is still outstanding — which is the whole claim.
    await vi.waitFor(async () => expect(await frameForFill(1)).toMatchObject({ frameId: 3 }));

    release();
    await pending;
  });
});
