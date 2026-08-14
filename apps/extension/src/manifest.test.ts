import { describe, expect, it } from 'vitest';
import manifestExport from './manifest';

// manifest.ts passes defineManifest a plain object, not a function/Promise, so this is safe.
const manifest = manifestExport as chrome.runtime.ManifestV3;

describe('manifest', () => {
  it('grants host permission for each platform API oracle used by the background service worker', () => {
    expect(manifest.host_permissions).toContain('https://boards-api.greenhouse.io/*');
    expect(manifest.host_permissions).toContain('https://api.smartrecruiters.com/*');
    expect(manifest.host_permissions).toContain('https://*.workable.com/*');
  });

  it('grants no host that no oracle calls — the Ashby host outlived the oracle that used it', () => {
    expect(manifest.host_permissions).not.toContain('https://api.ashbyhq.com/*');
  });

  it('still declares the local backend host permission', () => {
    expect(manifest.host_permissions).toContain('http://127.0.0.1:5391/*');
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
});
