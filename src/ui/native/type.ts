/**
 * Dynamic Type for v2's own overlays (outside v1's Preact tree). v1 sizes its text in rem of html's
 * `font: -apple-system-body`, which follows Settings › Accessibility › Display & Text Size (17 px at the
 * default size), capped at 1.6× so the accessibility sizes stay usable (vendor/v1 src/ui/styles/
 * tokens.css). `fs(px)` gives a size designed at `px` (default text size) the same scaling, so an overlay
 * grows with the rest of the app. Pair it with min-height (not height) on anything holding text.
 */
export const BODY_PX = 17;
export const MAX_SCALE = 1.6;

/** CSS length: `px` at the default text size, following Dynamic Type up to MAX_SCALE. */
export function fs(px: number): string {
  return `min(${Number((px / BODY_PX).toFixed(4))}rem,${Number((px * MAX_SCALE).toFixed(1))}px)`;
}
