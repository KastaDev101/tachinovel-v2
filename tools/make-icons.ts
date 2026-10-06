/**
 * Renders the app icon and the launch-screen images into the iOS asset catalog (no Mac needed).
 *
 *   - AppIcon.appiconset/AppIcon-1024.png   1024×1024, opaque (the App Store rejects icons with alpha)
 *   - Splash.imageset/splash-{light,dark}.png  2732×2732, a small centered book on the system
 *     background (white / black, like the v1 UI's --bg), picked by iOS per appearance
 *
 * The artwork is v1's home-screen icon (open book + bookmark, periwinkle accent). WebKit renders the
 * SVG; the PNG is then re-encoded as 8-bit RGB (alpha dropped) with node:zlib.
 *
 * Usage: node tools/make-icons.ts
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { webkit } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets');

const BOOK = `
  <defs>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#c3cbff"/>
      <stop offset="1" stop-color="#8e9cff"/>
    </linearGradient>
  </defs>
  <g transform="translate(512 548)">
    <path d="M-330 -210 C-210 -250 -90 -232 0 -170 L0 250 C-90 190 -210 172 -330 210 Z" fill="url(#acc)"/>
    <path d="M330 -210 C210 -250 90 -232 0 -170 L0 250 C90 190 210 172 330 210 Z" fill="url(#acc)" opacity="0.82"/>
    <g stroke="#1c1d2b" stroke-width="18" stroke-linecap="round" opacity="0.55">
      <path d="M-260 -120 C-190 -140 -120 -132 -60 -104"/>
      <path d="M-260 -40 C-190 -60 -120 -52 -60 -24"/>
      <path d="M-260 40 C-190 20 -120 28 -60 56"/>
      <path d="M260 -120 C190 -140 120 -132 60 -104"/>
      <path d="M260 -40 C190 -60 120 -52 60 -24"/>
      <path d="M260 40 C190 20 120 28 60 56"/>
    </g>
  </g>
  <path d="M600 330 L600 470 L640 438 L680 470 L680 330 Z" fill="#ffffff" opacity="0.92"/>`;

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c1d2b"/>
      <stop offset="1" stop-color="#05050a"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  ${BOOK}
</svg>`;

/**
 * Launch image: the book centered on the system background. LaunchScreen.storyboard aspect-FILLS the
 * square canvas into the portrait screen, so on an iPhone (956 pt tall) 2732 px ≈ 956 pt and the book
 * (660 icon units × 0.5 = 330 px) shows ~115 pt wide, about the size of iOS launch logos.
 */
function splash(bg: string): string {
  const size = 2732;
  const scale = 0.5;
  // (512, 520) is the book's visual center in icon units.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${bg}"/>
  <g transform="translate(${size / 2 - 512 * scale} ${size / 2 - 520 * scale}) scale(${scale})">${BOOK}</g>
</svg>`;
}

/** Re-encode an 8-bit RGBA PNG (as WebKit screenshots are) as opaque 8-bit RGB. */
export function pngDropAlpha(png: Buffer): Buffer {
  const sig = png.subarray(0, 8);
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, color, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || color !== 6 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, color ${color}, interlace ${interlace})`);
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const out = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      cur[x] = v & 0xff;
    }
    const o = y * (1 + width * 3);
    out[o] = 0;
    for (let x = 0; x < width; x++) {
      out[o + 1 + x * 3] = cur[x * 4]!;
      out[o + 2 + x * 3] = cur[x * 4 + 1]!;
      out[o + 3 + x * 3] = cur[x * 4 + 2]!;
    }
    cur.copy(prev);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolor, no alpha
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function writeSet(dir: string, files: Record<string, Buffer>, contents: unknown): void {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.png')) rmSync(path.join(dir, f));
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(dir, name), data);
  writeFileSync(path.join(dir, 'Contents.json'), `${JSON.stringify(contents, null, 2)}\n`);
}

async function main(): Promise<void> {
  const browser = await webkit.launch();
  const render = async (svg: string, size: number): Promise<Buffer> => {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    const png = await page.locator('svg').screenshot();
    await page.close();
    return pngDropAlpha(png);
  };
  const icon = await render(ICON, 1024);
  const light = await render(splash('#ffffff'), 2732);
  const dark = await render(splash('#000000'), 2732);
  await browser.close();

  writeSet(path.join(assets, 'AppIcon.appiconset'), { 'AppIcon-1024.png': icon }, {
    images: [{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
    info: { author: 'xcode', version: 1 },
  });
  writeSet(path.join(assets, 'Splash.imageset'), { 'splash-light.png': light, 'splash-dark.png': dark }, {
    images: [
      { filename: 'splash-light.png', idiom: 'universal' },
      { appearances: [{ appearance: 'luminosity', value: 'dark' }], filename: 'splash-dark.png', idiom: 'universal' },
    ],
    info: { author: 'xcode', version: 1 },
  });
  console.log(`icon ${icon.length} B, splash light ${light.length} B, dark ${dark.length} B`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
