/**
 * Inline `<script>` in the root layout's `<head>` (`src/app/layout.tsx`):
 * sets `data-density`, `data-text-scale` and the theme on `<html>` before
 * first paint, so a dark-mode or compact user never sees a light/cozy flash.
 * It duplicates, on purpose, what `@/lib/local-settings` and
 * `theme-switcher.tsx` read after hydration — the keys (`bctx:*`, with the
 * older `bcontext:density` still honoured) must stay in sync with them.
 *
 * Theme is `light` | `dark` | `system` (default `system`, resolved via
 * prefers-color-scheme); the resolved value is applied as both the `dark`
 * class and `data-theme` — HeroUI and the app CSS key off either.
 */
export function ThemeScript() {
  // The inline script only executes from the server-rendered HTML (pre-paint).
  // If React ever client-renders this tree (dev error recovery, HMR), the
  // theme classes are already applied — skip re-emitting the tag, which React
  // would warn about and never execute anyway.
  if (typeof window !== "undefined") return null;
  const src = `
    (function () {
      try {
        var d = localStorage.getItem('bctx:density') || localStorage.getItem('bcontext:density');
        if (d !== 'compact' && d !== 'cozy' && d !== 'comfortable') d = 'cozy';
        document.documentElement.dataset.density = d;
      } catch (e) {}
      try {
        var t = localStorage.getItem('bctx:text-scale');
        if (t !== 'large' && t !== 'xlarge') t = 'default';
        document.documentElement.dataset.textScale = t;
      } catch (e) {}
      try {
        var m = localStorage.getItem('bctx:theme');
        if (m !== 'light' && m !== 'dark') m = 'system';
        var dark = m === 'dark' || (m === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.classList.toggle('dark', dark);
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      } catch (e) {}
    })();
  `;
  return <script dangerouslySetInnerHTML={{ __html: src }} />;
}
