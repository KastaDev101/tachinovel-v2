/** Procedural placeholder art (inline SVG data URLs): novel covers, source icons, an illustration. */
import { hash, int, pick, rng } from './text-gen.ts';

function svgUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrap(title: string, max: number): string[] {
  const words = title.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > max) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

export function coverArt(title: string, author: string): string {
  const r = rng(hash(title));
  const h1 = int(r, 0, 359);
  const h2 = (h1 + int(r, 30, 140)) % 360;
  const style = int(r, 0, 3);
  let shapes = '';
  if (style === 0) {
    // moon over mountains
    shapes = `<circle cx="${int(r, 60, 140)}" cy="${int(r, 70, 120)}" r="${int(r, 24, 40)}" fill="hsl(${h2} 80% 88%)" opacity=".9"/>
<path d="M0 230 L50 170 L85 205 L130 140 L200 220 L200 300 L0 300Z" fill="hsl(${h1} 45% 18%)" opacity=".85"/>
<path d="M0 260 L40 225 L90 250 L150 205 L200 245 L200 300 L0 300Z" fill="hsl(${h1} 50% 10%)"/>`;
  } else if (style === 1) {
    // rings
    const cx = int(r, 50, 150);
    const cy = int(r, 80, 150);
    for (let i = 0; i < 5; i++) {
      shapes += `<circle cx="${cx}" cy="${cy}" r="${20 + i * 22}" fill="none" stroke="hsl(${h2} 85% 80%)" stroke-opacity="${(0.55 - i * 0.09).toFixed(2)}" stroke-width="${3 - i * 0.4}"/>`;
    }
  } else if (style === 2) {
    // diagonal bands
    for (let i = 0; i < 4; i++) {
      shapes += `<path d="M${-60 + i * 70} 300 L${40 + i * 70} 0 L${70 + i * 70} 0 L${-30 + i * 70} 300Z" fill="hsl(${(h2 + i * 12) % 360} 75% 75%)" opacity="${(0.12 + i * 0.06).toFixed(2)}"/>`;
    }
  } else {
    // tower silhouette
    const x = int(r, 70, 120);
    shapes = `<rect x="${x}" y="90" width="26" height="210" fill="hsl(${h1} 40% 12%)"/><path d="M${x - 6} 92 L${x + 13} 60 L${x + 32} 92Z" fill="hsl(${h1} 40% 12%)"/>
<rect x="${x + 10}" y="110" width="6" height="10" fill="hsl(${h2} 90% 75%)"/><circle cx="${int(r, 20, 180)}" cy="${int(r, 30, 80)}" r="2" fill="#fff" opacity=".8"/><circle cx="${int(r, 20, 180)}" cy="${int(r, 30, 80)}" r="1.5" fill="#fff" opacity=".7"/>`;
  }
  const lines = wrap(title, 13);
  const fs = lines.some((l) => l.length > 11) ? 19 : 22;
  const text = lines
    .map((l, i) => `<text x="100" y="${196 - (lines.length - 1) * fs * 0.6 + i * fs * 1.15}" text-anchor="middle">${esc(l)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" width="200" height="300">
<defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="hsl(${h1} 55% 42%)"/><stop offset="1" stop-color="hsl(${h2} 60% 18%)"/></linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient></defs>
<rect width="200" height="300" fill="url(#g)"/>${shapes}<rect width="200" height="300" fill="url(#s)"/>
<g font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${fs}" fill="#fff" letter-spacing=".5">${text}</g>
<text x="100" y="280" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="10" letter-spacing="2" fill="#fff" fill-opacity=".8">${esc(author.toUpperCase())}</text></svg>`;
  return svgUrl(svg);
}

export function sourceIcon(name: string, hue: number): string {
  const letter = esc(name.charAt(0).toUpperCase());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 58%)"/><stop offset="1" stop-color="hsl(${hue} 70% 44%)"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="43" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="30" fill="#fff">${letter}</text></svg>`;
  return svgUrl(svg);
}

export function illustration(seed: number): string {
  const r = rng(seed);
  const h = int(r, 0, 359);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180"><rect width="320" height="180" fill="hsl(${h} 35% 30%)"/><circle cx="${int(r, 60, 260)}" cy="60" r="26" fill="hsl(${(h + 40) % 360} 80% 85%)"/><path d="M0 140 L70 90 L120 120 L190 70 L320 140 L320 180 L0 180Z" fill="hsl(${h} 40% 14%)"/></svg>`;
  return svgUrl(svg);
}

export function pickHue(name: string): number {
  return pick(rng(hash(name)), [4, 24, 145, 200, 215, 262, 290, 330]);
}
