/**
 * ATS domains djobi supports — see `docs/architecture-plan.md`'s ATS allowlist. Single source of
 * truth for both the manifest's content-script host permissions (`manifest.ts`) and the popup's
 * runtime "is this a supported page?" check.
 */
export const ATS_DOMAINS = [
  'greenhouse.io',
  'ashbyhq.com',
  'lever.co',
  'myworkday.com',
  'smartrecruiters.com',
  'icims.com',
  'workable.com',
  'bamboohr.com',
];

/** Chrome MV3 match patterns for `ATS_DOMAINS`, e.g. `*://*.greenhouse.io/*`. */
export const ATS_HOST_PATTERNS = ATS_DOMAINS.map((domain) => `*://*.${domain}/*`);

/** True if `hostname` is one of `ATS_DOMAINS` or a subdomain of one. */
export function isSupportedAtsHost(hostname: string): boolean {
  return ATS_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}
