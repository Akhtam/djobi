/**
 * Watching a form this extension just filled for the candidate's own submission.
 *
 * The Save Step used to run only when the candidate clicked Save in the side panel. Fill a form,
 * press the site's own Submit button and close the tab, and nothing was ever recorded — the panel
 * is normally closed by then, and the submit navigates the tab away from the run. This is the
 * missing moment: the page telling the background that the application actually went out.
 *
 * **Armed only by a completed fill** (`content/index.ts`), never by detection. The detection
 * heuristic in `detect.ts` is allowed to be wrong because volunteering a detection costs nothing;
 * writing an Application row is not that kind of guess, so submission reporting is scoped to forms
 * this extension is already known to have filled.
 */
import { collapseWhitespace, getSignal } from './pageSignals';

/**
 * Button text that means "this sends the application", as opposed to the many other buttons an ATS
 * form carries — Next/Back on a multi-step form, "Upload", "Add another", cookie banners.
 *
 * Deliberately not `/next|continue/`: a wizard's Next is not a submission, and treating it as one
 * would save a half-finished application on the first page of a Workday flow.
 */
const SUBMIT_SIGNAL = /submit application|submit|send application|apply now|finish( and)? apply/i;

/** The elements a click on a submit control can actually land on, including a nested icon or span. */
function submitControlFor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('button, input[type="submit"], [role="button"]');
}

/**
 * What names a button, for the purpose of asking whether it submits.
 *
 * `getSignal` first, so an icon-only button reads by its `aria-label` exactly as the accessible-name
 * computation would — but its own text is the fallback rather than the other way round, because
 * `getSignal` is built for *form controls*, whose visible text is a value and never a name. A
 * button's text is its name, and for most ATS submit buttons it is the only one there is.
 */
function buttonLabel(doc: Document, control: Element): string {
  return getSignal(doc, control) || collapseWhitespace(control.textContent ?? '');
}

/**
 * Whether a click was a click on something that submits the form.
 *
 * Two tests, because many ATS submit buttons are not `type="submit"` inside a `<form>` at all —
 * the same reason `detect.ts` doesn't require a `<form>` ancestor. A native submit button counts by
 * its type; anything else has to say so in its accessible name, resolved through {@link getSignal}
 * so an `aria-label`-only icon button reads the same as a text one.
 */
function isSubmitClick(doc: Document, target: EventTarget | null): boolean {
  const control = submitControlFor(target);
  if (!control) return false;

  // A control the page has disabled cannot have submitted anything, whatever its `type` says — and
  // this has to be asked *before* the native-submit branch below, not after it. `aria-disabled` is
  // the accessible way to block a submit button while keeping it focusable, so it is exactly what
  // an ATS puts on `<button type="submit">Submit application</button>` while the form is still
  // incomplete — and unlike the `disabled` attribute, it does not stop the browser dispatching the
  // click. Asking afterwards meant that click reported a submission, and the Save Step recorded an
  // Application for a form the employer never received.
  if (control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true')
    return false;

  const type = control.getAttribute('type');
  if (type === 'submit') return true;
  // An explicit non-submit type is the author saying it isn't one; don't second-guess it by label.
  if (type !== null && type !== 'button') return false;

  return SUBMIT_SIGNAL.test(buttonLabel(doc, control));
}

/**
 * Calls `onSubmit` **once** when the candidate submits this page's form, and returns a stop function.
 *
 * Both listeners are registered in the **capture** phase. An ATS form's own handler routinely calls
 * `preventDefault`/`stopPropagation` on the click that starts its XHR submission, so a bubble-phase
 * listener on `document` never sees the event that matters. Capture runs on the way down, before
 * any of that.
 *
 * Nothing here touches the event: no `preventDefault`, no `stopPropagation`, no synthetic dispatch.
 * A watcher that changed the outcome of a real submission would be far worse than one that missed it.
 *
 * At most one call per arming, since a click on a submit button and the `submit` event it causes are
 * one submission, and a duplicate report would ask the background to save the same run twice.
 */
export function armSubmitWatch(doc: Document, onSubmit: () => void): () => void {
  let fired = false;

  function fire(): void {
    if (fired) return;
    fired = true;
    stop();
    onSubmit();
  }

  function handleSubmit(): void {
    fire();
  }

  function handleClick(event: Event): void {
    if (isSubmitClick(doc, event.target)) fire();
  }

  function stop(): void {
    doc.removeEventListener('submit', handleSubmit, true);
    doc.removeEventListener('click', handleClick, true);
  }

  doc.addEventListener('submit', handleSubmit, true);
  doc.addEventListener('click', handleClick, true);

  return stop;
}
