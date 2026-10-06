/**
 * Plugin `customCSS` (raw, untrusted) → a stylesheet scoped to one chapter's content.
 * Parsed with the browser's CSS parser (CSSStyleSheet.replaceSync ignores @import), then rebuilt
 * from an allowlist: only plain style rules (optionally inside @media), only typographic/box
 * properties, no url()/expression()/javascript:, no positioning, no `content`, and every selector is
 * prefixed with the chapter scope. Pure helpers are unit-tested; `scopeCustomCss` needs a DOM.
 */

const ALLOWED_PROPS = new Set([
  'color', 'background-color', 'opacity',
  'font-style', 'font-weight', 'font-variant', 'font-size', 'letter-spacing', 'word-spacing', 'line-height',
  'white-space', 'vertical-align', 'display', 'width', 'max-width', 'height', 'max-height', 'list-style-type',
  'border-collapse',
]);

/** Property families allowed by prefix (the CSSOM expands shorthands into these longhands). */
const ALLOWED_FAMILIES = ['margin', 'padding', 'border', 'text', 'font-variant'];
const DENIED_FAMILIES = ['border-image'];

function inFamily(p: string, family: string): boolean {
  return p === family || p.startsWith(`${family}-`);
}

function propAllowed(p: string): boolean {
  if (ALLOWED_PROPS.has(p)) return true;
  if (DENIED_FAMILIES.some((d) => inFamily(p, d))) return false;
  return ALLOWED_FAMILIES.some((f) => inFamily(p, f));
}

/** Values that could load resources, run code, or escape the declaration. */
const BAD_VALUE = /url\s*\(|expression\s*\(|javascript:|vbscript:|@import|-moz-binding|behavior\s*:|[<>{}\\]|image-set|element\s*\(/i;

/** Display values that could pull content out of flow over the app chrome. */
const BAD_DISPLAY = /contents/i;

export function isAllowedDeclaration(prop: string, value: string): boolean {
  const p = prop.trim().toLowerCase();
  if (!propAllowed(p)) return false;
  if (BAD_VALUE.test(value)) return false;
  if (p === 'display' && BAD_DISPLAY.test(value)) return false;
  return true;
}

/** Split a selector list on top-level commas (not inside () or []). */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Prefix each selector with `scope`. Selectors aimed at the document itself (html, body, :root,
 * :host) or using pseudo-elements that inject content are dropped. Returns null if nothing is left.
 */
export function scopeSelector(selectorText: string, scope: string): string | null {
  const kept: string[] = [];
  for (const sel of splitSelectors(selectorText)) {
    if (!sel) continue;
    if (/(^|[\s>+~,(])(html|body|:root|:host)\b/i.test(sel)) continue;
    if (/::?(before|after|marker|backdrop|selection|placeholder)/i.test(sel)) continue;
    kept.push(`${scope} ${sel}`);
  }
  return kept.length > 0 ? kept.join(', ') : null;
}

function rebuildRule(rule: CSSRule, scope: string): string {
  if (rule instanceof CSSStyleRule) {
    const sel = scopeSelector(rule.selectorText, scope);
    if (!sel) return '';
    const decls: string[] = [];
    const st = rule.style;
    for (let i = 0; i < st.length; i++) {
      const prop = st.item(i);
      const value = st.getPropertyValue(prop);
      if (isAllowedDeclaration(prop, value)) decls.push(`${prop}: ${value}${st.getPropertyPriority(prop) ? ' !important' : ''}`);
    }
    return decls.length > 0 ? `${sel} { ${decls.join('; ')} }` : '';
  }
  if (rule instanceof CSSMediaRule) {
    const inner = Array.from(rule.cssRules)
      .map((r) => rebuildRule(r, scope))
      .filter(Boolean)
      .join('\n');
    return inner ? `@media ${rule.media.mediaText} {\n${inner}\n}` : '';
  }
  // @import, @font-face, @keyframes, @namespace, @page, @supports, … are dropped.
  return '';
}

/** Sanitized, scoped CSS text ('' if nothing survives or the CSS can't be parsed). */
export function scopeCustomCss(css: string | undefined, scope: string): string {
  if (!css || css.length > 20_000) return '';
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return Array.from(sheet.cssRules)
      .map((r) => rebuildRule(r, scope))
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}
