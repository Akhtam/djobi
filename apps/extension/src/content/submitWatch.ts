/**
 * Watches a form this extension just filled for the candidate's own submit, so the application is
 * saved even if the panel is closed. **Armed only by a completed fill**, never by detection —
 * writing an Application shouldn't rest on the detection heuristic.
 */
import { collapseWhitespace, getSignal } from './pageSignals';

/**
 * Button text meaning "send the application". Deliberately not `next|continue`: a wizard's Next
 * isn't a submission.
 */
const SUBMIT_SIGNAL = /submit application|submit|send application|apply now|finish( and)? apply/i;

/**
 * The elements a click on a submit control can actually land on, including a nested icon or span.
 */
function submitControlFor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('button, input[type="submit"], [role="button"]');
}

/**
 * A button's name for the submit test: `getSignal` first (so icon buttons read by `aria-label`),
 * then its own text.
 */
function buttonLabel(doc: Document, control: Element): string {
  return getSignal(doc, control) || collapseWhitespace(control.textContent ?? '');
}

/**
 * Whether a click was on something that submits: a native submit button, or any control whose
 * accessible name says so (many ATS submit buttons aren't `type="submit"`).
 */
function isSubmitClick(doc: Document, target: EventTarget | null): boolean {
  const control = submitControlFor(target);
  if (!control) return false;

  // Disabled controls can't submit — checked *before* the native-submit test, because
  // `aria-disabled` (common on an incomplete form's submit button) doesn't stop the click event.
  if (control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true')
    return false;

  const type = control.getAttribute('type');
  if (type === 'submit') return true;
  // An explicit non-submit type is the author saying it isn't one; don't second-guess it by label.
  if (type !== null && type !== 'button') return false;

  return SUBMIT_SIGNAL.test(buttonLabel(doc, control));
}

/**
 * Calls `onSubmit` **once** when the candidate submits, and returns a stop function. Listens in the
 * **capture** phase, since ATS handlers often stop propagation. Never touches the event.
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
