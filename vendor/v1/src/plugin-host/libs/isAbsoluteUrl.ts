/** @libs/isAbsoluteUrl — copy of LNReader's isUrlAbsolute (LNReader/lnreader, MIT). */
export const isUrlAbsolute = (url: string): boolean => {
  if (url) {
    if (url.indexOf('//') === 0) return true; // protocol-relative
    if (url.indexOf('://') === -1) return false; // no protocol
    if (url.indexOf('.') === -1) return false; // no TLD
    if (url.indexOf('/') === -1) return false;
    if (url.indexOf(':') > url.indexOf('/')) return false; // first colon after the first slash
    if (url.indexOf('://') < url.indexOf('.')) return true; // protocol before the first dot
  }
  return false;
};
