/**
 * The two facts `index.html`'s pre-paint script and `theme.tsx`'s React state must agree on. Split
 * out on its own — rather than each side hardcoding its own copy of the key/default — so the two
 * can never drift: a renamed key or a changed default only has one place to change.
 */
export const THEME_KEY = 'djobi-dashboard-theme';
export const DEFAULT_THEME = 'dark';
