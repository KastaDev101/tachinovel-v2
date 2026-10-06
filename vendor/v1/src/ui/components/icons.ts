/**
 * Icon set. Keys are SF Symbol names: on the phone the script renders the real SF Symbols
 * (`native.symbols`) and the UI uses them as CSS masks so they can be tinted. Until they arrive (or
 * in dev/tests) an inline-SVG fallback drawn on the same 24×24 grid is used the same way.
 */

const S = '<g fill="#000" stroke="none">';
const E = '</g>';

function gearPath(filled = false): string {
  const teeth = 8;
  const rOuter = 10;
  const rInner = 7.7;
  const pts: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    const angles = [a0 - step * 0.2, a0 - step * 0.12, a0 + step * 0.12, a0 + step * 0.2];
    const radii = [rInner, rOuter, rOuter, rInner];
    angles.forEach((a, j) => {
      const r = radii[j] ?? rInner;
      pts.push(`${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`);
    });
  }
  if (filled) return `<path d="M${pts.join('L')}z"/>`;
  return `<path d="M${pts.join('L')}z"/><circle cx="12" cy="12" r="3.1"/>`;
}

function masked(id: string, shape: string, cut: string): string {
  return `<defs><mask id="${id}"><rect width="24" height="24" fill="#fff"/>${cut}</mask></defs><g mask="url(#${id})">${shape}</g>`;
}

const ICONS: Record<string, string> = {
  // tab bar
  'books.vertical.fill': `${S}<rect x="2.6" y="4.2" width="5" height="16.3" rx="1.3"/><rect x="9" y="2.8" width="5" height="17.7" rx="1.3"/><rect x="15.5" y="4.4" width="5" height="16.3" rx="1.3" transform="rotate(-13 18 12.55)"/>${E}`,
  'bell.fill': `${S}<path d="M12 2.6c-3.5 0-6.1 2.7-6.1 6.2v3.5c0 .9-.4 1.8-1 2.5l-.9 1c-.7.8-.1 2 .9 2h14.2c1 0 1.6-1.2.9-2l-.9-1c-.6-.7-1-1.6-1-2.5V8.8c0-3.5-2.6-6.2-6.1-6.2z"/><path d="M9.3 19.3h5.4a2.7 2.7 0 0 1-5.4 0z"/>${E}`,
  'clock.fill': masked('c', `${S}<circle cx="12" cy="12" r="10"/>${E}`, '<path d="M12 6.6V12l3.6 2.2" stroke="#000" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  'square.grid.2x2.fill': `${S}<rect x="2.8" y="2.8" width="8.2" height="8.2" rx="2.3"/><rect x="13" y="2.8" width="8.2" height="8.2" rx="2.3"/><rect x="2.8" y="13" width="8.2" height="8.2" rx="2.3"/><rect x="13" y="13" width="8.2" height="8.2" rx="2.3"/>${E}`,
  'ellipsis.circle.fill': masked('e', `${S}<circle cx="12" cy="12" r="10"/>${E}`, '<g fill="#000"><circle cx="7.4" cy="12" r="1.55"/><circle cx="12" cy="12" r="1.55"/><circle cx="16.6" cy="12" r="1.55"/></g>'),

  'bolt.fill': `${S}<path d="M13.6 2.2 4.9 13.1c-.4.5 0 1.2.6 1.2h5.6l-1.5 7.2c-.1.6.6.9 1 .4l8.7-10.9c.4-.5 0-1.2-.6-1.2h-5.6l1.5-7.2c.1-.6-.6-.9-1-.4z"/>${E}`,
  'gearshape.fill': masked('g', `${S}${gearPath(true)}${E}`, '<circle cx="12" cy="12" r="3.3" fill="#000"/>'),

  // navigation & actions
  'chevron.left': '<path d="M15.5 4 7.5 12l8 8" stroke-width="2.5"/>',
  'chevron.right': '<path d="M9 4.5 16.5 12 9 19.5" stroke-width="2.3"/>',
  'chevron.down': '<path d="M4.5 9 12 16.5 19.5 9" stroke-width="2.3"/>',
  'chevron.up': '<path d="M4.5 15 12 7.5l7.5 7.5" stroke-width="2.3"/>',
  'chevron.up.chevron.down': '<path d="M7.5 9.5 12 5l4.5 4.5M7.5 14.5 12 19l4.5-4.5" stroke-width="2.1"/>',
  magnifyingglass: '<circle cx="10.4" cy="10.4" r="6.6" stroke-width="2.1"/><path d="M15.3 15.3 20.6 20.6" stroke-width="2.5"/>',
  'line.3.horizontal.decrease': '<path d="M3.5 6.5h17M6.5 12h11M10 17.5h4" stroke-width="2.1"/>',
  'line.3.horizontal.decrease.circle': '<circle cx="12" cy="12" r="9.6"/><path d="M7 9h10M8.8 12.4h6.4M10.8 15.8h2.4"/>',
  'arrow.up.arrow.down': '<path d="M7.5 20V4.5M3.8 8.2l3.7-3.7 3.7 3.7M16.5 4v15.5M12.8 15.8l3.7 3.7 3.7-3.7"/>',
  'arrow.up': '<path d="M12 19.5v-15M6 10.5l6-6 6 6" stroke-width="2.1"/>',
  'arrow.down': '<path d="M12 4.5v15M6 13.5l6 6 6-6" stroke-width="2.1"/>',
  ellipsis: `${S}<circle cx="5" cy="12" r="2.1"/><circle cx="12" cy="12" r="2.1"/><circle cx="19" cy="12" r="2.1"/>${E}`,
  'ellipsis.circle': `<circle cx="12" cy="12" r="9.6"/>${S}<circle cx="7.6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="16.4" cy="12" r="1.4"/>${E}`,
  plus: '<path d="M12 4.5v15M4.5 12h15" stroke-width="2.3"/>',
  minus: '<path d="M5 12h14" stroke-width="2.3"/>',
  xmark: '<path d="M6 6l12 12M18 6 6 18" stroke-width="2.3"/>',
  'xmark.circle.fill': masked('x', `${S}<circle cx="12" cy="12" r="10"/>${E}`, '<path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8" stroke="#000" stroke-width="2.1" stroke-linecap="round"/>'),
  checkmark: '<path d="M4.5 12.8l5 5L19.5 6.8" stroke-width="2.5"/>',
  'checkmark.circle': '<circle cx="12" cy="12" r="9.6"/><path d="M7.6 12.4l3 3 5.8-6.2" stroke-width="2.1"/>',
  'checkmark.circle.fill': masked('k', `${S}<circle cx="12" cy="12" r="10"/>${E}`, '<path d="M7.5 12.4l3.1 3.1 6-6.4" stroke="#000" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  circle: '<circle cx="12" cy="12" r="9.6" stroke-width="1.6"/>',
  'arrow.clockwise': '<path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4" stroke-width="2.1"/><path d="M19.6 3.6v4.8h-4.8" stroke-width="2.1"/>',
  'arrow.triangle.2.circlepath': '<path d="M4.5 12a7.5 7.5 0 0 1 12.9-5.2L19.5 9M19.5 4.5V9H15M19.5 12a7.5 7.5 0 0 1-12.9 5.2L4.5 15M4.5 19.5V15H9"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4.8c0-.7.5-1.3 1.3-1.3h2.4c.8 0 1.3.6 1.3 1.3v1.7M6.3 6.5l.9 13c.1.9.8 1.5 1.6 1.5h6.4c.8 0 1.5-.6 1.6-1.5l.9-13M10 10.5v6.5M14 10.5v6.5"/>',
  pin: '<path d="M9 3.5h6l-.9 5.6 3.4 3.4v1.6H6.5v-1.6l3.4-3.4z"/><path d="M12 14.1v6.4"/>',
  'pin.fill': `${S}<path d="M8.6 2.8h6.8c.5 0 .8.4.7.9l-.9 5.2 3.2 3.2c.2.2.3.4.3.6v1.6c0 .4-.3.7-.7.7H5.9c-.4 0-.7-.3-.7-.7v-1.6c0-.2.1-.4.3-.6L8.7 8.9l-.9-5.2c-.1-.5.2-.9.8-.9z"/>${E}<path d="M12 15v5.5"/>`,
  'square.and.arrow.up': '<path d="M12 3v12M8.2 6.8 12 3l3.8 3.8"/><path d="M8.5 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5h-2"/>',
  globe: '<circle cx="12" cy="12" r="9.6"/><ellipse cx="12" cy="12" rx="4" ry="9.6"/><path d="M2.8 9h18.4M2.8 15h18.4"/>',
  safari: `<circle cx="12" cy="12" r="9.6"/>${S}<path d="M16.2 7.8 13.5 13.5 7.8 16.2 10.5 10.5z"/>${E}`,
  'arrow.down.circle': '<circle cx="12" cy="12" r="9.6"/><path d="M12 7v9.5M8 12.8l4 4 4-4"/>',
  'arrow.down.circle.fill': masked('d', `${S}<circle cx="12" cy="12" r="10"/>${E}`, '<path d="M12 6.8v9.6M7.9 12.6l4.1 4.1 4.1-4.1" stroke="#000" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  'play.fill': `${S}<path d="M7 4.6v14.8c0 .8.9 1.3 1.6.9l11.7-7.4c.6-.4.6-1.4 0-1.8L8.6 3.7C7.9 3.3 7 3.8 7 4.6z"/>${E}`,
  'stop.fill': `${S}<rect x="5.5" y="5.5" width="13" height="13" rx="2.6"/>${E}`,
  'pause.fill': `${S}<rect x="6" y="4.5" width="4.2" height="15" rx="1.4"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.4"/>${E}`,
  'arrow.down.doc': '<path d="M6 2.8h8.2L19 7.6v12.1a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.7V4.3A1.5 1.5 0 0 1 6.5 2.8z"/><path d="M12 9v7.5M9 13.6l3 3 3-3"/>',
  'backward.end.fill': `<path d="M5.5 5v14" stroke-width="2.4"/>${S}<path d="M19.5 5.7v12.6c0 .8-.9 1.3-1.6.8L9 12.8c-.6-.4-.6-1.3 0-1.7l8.9-6.2c.7-.5 1.6 0 1.6.8z"/>${E}`,
  'forward.end.fill': `<path d="M18.5 5v14" stroke-width="2.4"/>${S}<path d="M4.5 5.7v12.6c0 .8.9 1.3 1.6.8l8.9-6.3c.6-.4.6-1.3 0-1.7L6.1 4.9c-.7-.5-1.6 0-1.6.8z"/>${E}`,
  'lock.fill': `<path d="M7.6 10.4V7.8a4.4 4.4 0 0 1 8.8 0v2.6" stroke-width="2.2"/>${S}<rect x="4.6" y="10" width="14.8" height="11.4" rx="2.6"/>${E}`,
  bookmark: '<path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.6-6.5 4.6v-16a1 1 0 0 1 1-1z"/>',
  'bookmark.fill': `${S}<path d="M6.3 2.8h11.4c.8 0 1.5.7 1.5 1.5v16.3c0 .6-.7.9-1.2.6L12 16.6l-6 4.6c-.5.3-1.2 0-1.2-.6V4.3c0-.8.7-1.5 1.5-1.5z"/>${E}`,
  heart: '<path d="M12 20.3s-8.2-4.9-8.2-11.1a4.6 4.6 0 0 1 8.2-2.9 4.6 4.6 0 0 1 8.2 2.9c0 6.2-8.2 11.1-8.2 11.1z"/>',
  'heart.fill': `${S}<path d="M12 21s-8.9-5.2-8.9-11.8A5.1 5.1 0 0 1 12 5.9a5.1 5.1 0 0 1 8.9 3.3C20.9 15.8 12 21 12 21z"/>${E}`,
  'star.fill': `${S}<path d="M12 2.8l2.7 5.9 6.4.7-4.8 4.4 1.3 6.3L12 17l-5.6 3.1 1.3-6.3-4.8-4.4 6.4-.7z"/>${E}`,
  clock: '<circle cx="12" cy="12" r="9.6"/><path d="M12 7v5l3.3 2"/>',

  // reader
  'textformat.size': '<path d="M2.5 19 8 5h1.2l5.4 14M4.5 14.2h8.2" stroke-width="2"/><circle cx="18.3" cy="15.7" r="2.9" stroke-width="2"/><path d="M21.2 12.4V19" stroke-width="2"/>',
  'sun.max': '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M5.3 18.7l1.5-1.5M17.2 6.8l1.5-1.5"/>',
  'sun.min': '<circle cx="12" cy="12" r="3.4"/><path d="M12 5.4v.8M12 17.8v.8M5.4 12h.8M17.8 12h.8M7.3 7.3l.6.6M16.1 16.1l.6.6M7.3 16.7l.6-.6M16.1 7.9l.6-.6" stroke-width="2.2"/>',
  'moon.fill': `${S}<path d="M20.3 14.6A8.6 8.6 0 0 1 9.4 3.7a8.6 8.6 0 1 0 10.9 10.9z"/>${E}`,
  'list.bullet': `${S}<circle cx="4.6" cy="6" r="1.6"/><circle cx="4.6" cy="12" r="1.6"/><circle cx="4.6" cy="18" r="1.6"/>${E}<path d="M9 6h11.5M9 12h11.5M9 18h11.5"/>`,
  number: '<path d="M9.8 3.5 7.6 20.5M16.4 3.5l-2.2 17M4.2 8.6h16.3M3.5 15.4h16.3"/>',

  // settings
  gearshape: gearPath(),
  'info.circle': `<circle cx="12" cy="12" r="9.6"/><path d="M12 11v6" stroke-width="2.2"/>${S}<circle cx="12" cy="7.6" r="1.35"/>${E}`,
  internaldrive: `<rect x="2.5" y="7" width="19" height="10" rx="2.6"/><path d="M6 12h6"/>${S}<circle cx="17" cy="12" r="1.3"/>${E}`,
  'puzzlepiece.extension': '<path d="M4 7.5h4.1a2.2 2.2 0 1 1 4.3 0H17v4.6a2.2 2.2 0 1 1 0 4.3V21H4z"/>',
  folder: '<path d="M3 7.5v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-7.2L9.6 5.5H5a2 2 0 0 0-2 2z"/>',
  'circle.lefthalf.filled': `<circle cx="12" cy="12" r="9.6"/>${S}<path d="M12 2.4a9.6 9.6 0 0 0 0 19.2z"/>${E}`,
  book: '<path d="M12 6.5C10 5 7.3 4.5 3.5 4.8v13.7c3.8-.3 6.5.2 8.5 1.7 2-1.5 4.7-2 8.5-1.7V4.8C16.7 4.5 14 5 12 6.5zM12 6.5v13.7"/>',
  'book.clock': '<path d="M15.5 10.4V3.5H6.6A1.6 1.6 0 0 0 5 5.1v13.4a1.6 1.6 0 0 0 1.6 1.6h4.2"/><path d="M5 16.9a1.6 1.6 0 0 1 1.6-1.6h4"/><circle cx="16.8" cy="16.6" r="4.4"/><path d="M16.8 14.6v2.1l1.4.9"/>',
  'book.closed': '<path d="M6 3.5h12.5v14H7.6A1.6 1.6 0 0 0 6 19.1z"/><path d="M6 19.1a1.6 1.6 0 0 0 1.6 1.6h10.9v-3.2"/>',
  eyeglasses: '<circle cx="6.8" cy="14" r="3.8"/><circle cx="17.2" cy="14" r="3.8"/><path d="M10.6 13.4c.9-.6 1.9-.6 2.8 0M3 14 4.6 8M21 14l-1.6-6"/>',
  shippingbox: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  hammer: '<path d="M13.3 4.2 19.8 10.7 17.6 12.9 11.1 6.4z"/><path d="M14.5 9.7 5.3 18.9a1.6 1.6 0 0 0 2.3 2.3l9.2-9.2"/>',
  'doc.on.clipboard': '<rect x="5" y="4.5" width="14" height="17" rx="2.2"/><path d="M9 4.5v-.7c0-.7.5-1.3 1.3-1.3h3.4c.8 0 1.3.6 1.3 1.3v.7M8.5 10h7M8.5 13.5h7M8.5 17h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.2-3.2a4 4 0 0 0-5.7-5.7l-1.4 1.4M14 10a4 4 0 0 0-5.7 0l-3.2 3.2a4 4 0 0 0 5.7 5.7l1.4-1.4"/>',

  translate: '<path d="M3 5.5h9M7.5 3.5v2M4.8 5.5c.9 3.1 2.9 5.4 5.7 6.9M10.2 5.5c-.9 3.4-3 6-6.7 7.9"/><path d="M12.5 21l4.2-10.5L21 21M14 17.5h5.4"/>',
  'xmark.bin': '<path d="M3.5 7.5h17v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M2.5 3.5h19v4h-19zM9.5 11.5l5 5M14.5 11.5l-5 5"/>',
  'slider.horizontal.3': '<path d="M3.5 6.5h9M16.5 6.5h4M3.5 12h3M10.5 12h10M3.5 17.5h11M18.5 17.5h2"/><circle cx="14.5" cy="6.5" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="16.5" cy="17.5" r="2"/>',
  paintpalette: `<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-.9 2-1.9 0-1.4-1.3-1.6-1.3-2.9 0-1 .8-1.7 1.8-1.7h2.3A4.2 4.2 0 0 0 21 10.4C21 6.3 17 3 12 3z"/>${S}<circle cx="7.6" cy="11.5" r="1.4"/><circle cx="9.6" cy="7.4" r="1.4"/><circle cx="14.4" cy="7.4" r="1.4"/>${E}`,
  'arrow.down.to.line': '<path d="M12 3.5v12M7 10.5l5 5 5-5M5 20.5h14"/>',
  'clock.arrow.circlepath': '<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8L3.5 9"/><path d="M3.5 4.5V9H8"/><path d="M12 8v4.3l3 1.8"/>',
  hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 4.5 4.5 5.5 4.5 8.5s-4.5 4-4.5 8.5M16.5 3.5c0 4.5-4.5 5.5-4.5 8.5s4.5 4 4.5 8.5"/>',
  'doc.text': '<path d="M6 2.8h8.2L19 7.6v12.1a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.7V4.3A1.5 1.5 0 0 1 6.5 2.8z"/><path d="M14 2.8v5h5M8.5 12.5h7M8.5 16h7"/>',

  // states
  'exclamationmark.triangle': `<path d="M10.3 4.2 2.6 17.8c-.8 1.3.2 3 1.7 3h15.4c1.5 0 2.5-1.7 1.7-3L13.7 4.2c-.8-1.3-2.6-1.3-3.4 0z"/><path d="M12 9.5v4.5" stroke-width="2.2"/>${S}<circle cx="12" cy="17.2" r="1.3"/>${E}`,
  'wifi.slash': `<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.3a9.5 9.5 0 0 1 13 0M8.6 15.5a5 5 0 0 1 6.8 0"/>${S}<circle cx="12" cy="19" r="1.4"/>${E}<path d="M4 3.5l16.5 17"/>`,
  tray: '<path d="M3.5 13.5 6 5.5h12l2.5 8V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5h4.6a3.9 3.9 0 0 0 7.8 0h4.6"/>',
};

/** SF Symbol names the UI uses (asked from the script once at startup). */
export const SYMBOL_NAMES: readonly string[] = Object.keys(ICONS);

const cache = new Map<string, string>();

/** data:image/svg+xml URL of the fallback glyph (black on transparent — used as a mask). */
export function fallbackIconUrl(name: string): string {
  let url = cache.get(name);
  if (url !== undefined) return url;
  const body = ICONS[name] ?? ICONS['circle'] ?? '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(name, url);
  return url;
}

export function hasIcon(name: string): boolean {
  return name in ICONS;
}
