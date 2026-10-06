/**
 * DOMPurify configuration for untrusted chapter HTML (pure data; unit-tested).
 * Strict allowlist from CLAUDE.md: text structure, images and tables only. No styles, no classes,
 * no ids, no links, nothing active. Images must be https: or data:image/.
 */

export const ALLOWED_TAGS: readonly string[] = [
  'p', 'br', 'hr', 'em', 'strong', 'i', 'b', 'u', 's', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'sub', 'sup', 'small', 'del', 'ins',
];

export const ALLOWED_ATTR: readonly string[] = ['src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan'];

/** Never allowed, even if a future allowlist edit adds them by mistake. */
export const FORBID_TAGS: readonly string[] = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math', 'template', 'noscript',
  'audio', 'video', 'source', 'track', 'canvas', 'a', 'area', 'map', 'portal', 'slot',
];

export const FORBID_ATTR: readonly string[] = ['style', 'class', 'id', 'name', 'href', 'srcset', 'action', 'formaction', 'xlink:href', 'background', 'poster'];

/**
 * DOMPurify checks every non-"URI-safe" attribute value against this regex. Allow https:, data:image/
 * and scheme-less values (numbers like width="300", plain words); reject every other scheme.
 */
export const ALLOWED_URI_REGEXP = /^(?:https:|data:image\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const IMAGE_SRC = /^(?:https:\/\/[^\s]+|data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,][^\s]*)$/i;

/** Images load only from https: or inline data:image/ URLs. Relative and http: URLs are dropped. */
export function isAllowedImageSrc(src: string): boolean {
  // Strip control characters and whitespace (browsers ignore them inside URL schemes).
  let v = '';
  for (const ch of src) {
    if (ch.charCodeAt(0) > 0x20 && !/\s/.test(ch)) v += ch;
  }
  return IMAGE_SRC.test(v);
}

export interface PurifyConfigShape {
  ALLOWED_TAGS: string[];
  ALLOWED_ATTR: string[];
  FORBID_TAGS: string[];
  FORBID_ATTR: string[];
  ALLOWED_URI_REGEXP: RegExp;
  ALLOW_DATA_ATTR: boolean;
  ALLOW_ARIA_ATTR: boolean;
  ALLOW_UNKNOWN_PROTOCOLS: boolean;
  ALLOW_SELF_CLOSE_IN_ATTR: boolean;
  SAFE_FOR_TEMPLATES: boolean;
  WHOLE_DOCUMENT: boolean;
  KEEP_CONTENT: boolean;
  USE_PROFILES: false;
}

export function purifyConfig(): PurifyConfigShape {
  return {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    FORBID_TAGS: [...FORBID_TAGS],
    FORBID_ATTR: [...FORBID_ATTR],
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOW_SELF_CLOSE_IN_ATTR: false,
    SAFE_FOR_TEMPLATES: false,
    WHOLE_DOCUMENT: false,
    KEEP_CONTENT: true,
    USE_PROFILES: false,
  };
}

/** Tags whose presence in sanitized output would be a sanitizer failure (used by tests). */
export const DANGEROUS_TAGS: readonly string[] = FORBID_TAGS;
