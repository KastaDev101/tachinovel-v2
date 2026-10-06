/** UTF-8 byte length without TextEncoder (missing in Scriptable): native regex/encodeURIComponent only. */
export function utf8Length(s: string): number {
  // eslint-disable-next-line no-control-regex -- ASCII fast path (the common case for HTML/JSON)
  if (/^[\x00-\x7f]*$/.test(s)) return s.length;
  try {
    const encoded = encodeURIComponent(s);
    return encoded.length - 2 * (encoded.split('%').length - 1);
  } catch {
    return s.length * 3; // lone surrogates: worst case
  }
}
