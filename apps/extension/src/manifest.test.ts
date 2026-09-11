import { describe, expect, it } from 'vitest';
import { DASHBOARD_DEV_ORIGINS, EXTENSION_BACKEND_ORIGIN, EXTENSION_ID } from './extensionConfig';
import manifestExport from './manifest';

// manifest.ts passes defineManifest a plain object, not a function/Promise, so this is safe.
const manifest = manifestExport as chrome.runtime.ManifestV3;

/**
 * Chrome's own algorithm for deriving an extension id from its public key: SHA-256 the DER-encoded
 * SPKI key, take the first 16 bytes, and map each nibble onto 'a'..'p' instead of a hex digit.
 * Reproduced here rather than trusted by inspection, so a future re-generated key that doesn't
 * actually match `EXTENSION_ID` fails loudly instead of silently locking `trustedOrigins` out.
 */
async function extensionIdFromManifestKey(base64Key: string): Promise<string> {
  const der = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  return Array.from(digest.slice(0, 16))
    .map((byte) => 'abcdefghijklmnop'[byte >> 4] + 'abcdefghijklmnop'[byte & 0x0f])
    .join('');
}

describe('manifest', () => {
  it("pins the extension's id via key, matching EXTENSION_ID exactly", async () => {
    expect(manifest.key).toBeTruthy();
    await expect(extensionIdFromManifestKey(manifest.key!)).resolves.toBe(EXTENSION_ID);
  });

  it('grants host permission for each platform API oracle used by the background service worker', () => {
    expect(manifest.host_permissions).toContain('https://boards-api.greenhouse.io/*');
    expect(manifest.host_permissions).toContain('https://api.smartrecruiters.com/*');
    expect(manifest.host_permissions).toContain('https://*.workable.com/*');
  });

  it('grants no host that no oracle calls — the Ashby host outlived the oracle that used it', () => {
    expect(manifest.host_permissions).not.toContain('https://api.ashbyhq.com/*');
  });

  it('still declares the local backend host permission', () => {
    expect(manifest.host_permissions).toContain(`${EXTENSION_BACKEND_ORIGIN}/*`);
  });

  /**
   * `sharedSessionCookie.ts`'s `chrome.cookies` calls against the dashboard's dev-server origins
   * only resolve real cookies (rather than the `null` a missing `host_permissions` entry produces
   * indistinguishably from an absent one) when the manifest actually grants them — see
   * `DASHBOARD_DEV_ORIGINS`'s own doc comment for why local dev needs these at all.
   */
  it('grants host permission for the dashboard dev-server origins, for the shared session cookie', () => {
    expect(DASHBOARD_DEV_ORIGINS.length).toBeGreaterThan(0);
    for (const origin of DASHBOARD_DEV_ORIGINS) {
      expect(manifest.host_permissions).toContain(`${origin}/*`);
    }
  });

  it("injects the content script on every http(s) page, not a fixed ATS-domain allowlist, so white-labeled ATS embeds on a company's own domain (e.g. Ashby on superhuman.com) are reachable", () => {
    const [contentScript] = manifest.content_scripts!;
    expect(contentScript.matches).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*']));
  });

  it('runs the content script in every frame, so iframe-embedded application forms are reachable too', () => {
    const [contentScript] = manifest.content_scripts!;
    expect(contentScript.all_frames).toBe(true);
  });

  it('has no default_popup, so the toolbar icon opens the side panel instead', () => {
    expect(manifest.action?.default_popup).toBeUndefined();
  });

  it("registers the side panel as the extension's review UI", () => {
    expect(manifest.side_panel?.default_path).toBe('src/panel/index.html');
    expect(manifest.permissions).toContain('sidePanel');
  });

  it('grants tabs permission so the side panel can retain the active application URL after navigation', () => {
    expect(manifest.permissions).toContain('tabs');
  });

  it('grants webNavigation only for enumerating frames when scraping an embedded posting', () => {
    expect(manifest.permissions).toContain('webNavigation');
  });

  it('grants cookies, for reading/writing the dashboard’s shared session', () => {
    expect(manifest.permissions).toContain('cookies');
  });
});
