import type { Profile, TailoredResume } from '@djobi/shared';

const BACKEND_ORIGIN = 'http://127.0.0.1:5391';

/**
 * Fetches the rendered resume PDF for `profile`/`tailoredResume` directly (bypassing the
 * `callBackend`/`sendToBackground` JSON relay, whose `res.json()` can't parse a binary PDF
 * response) and resolves with the raw bytes.
 */
export async function fetchResumePdf(
  profile: Profile,
  tailoredResume: TailoredResume,
): Promise<ArrayBuffer> {
  const res = await fetch(`${BACKEND_ORIGIN}/render-resume-pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile, tailoredResume }),
  });

  if (!res.ok) {
    throw new Error(`Failed to render resume PDF (status ${res.status})`);
  }

  return res.arrayBuffer();
}
