/**
 * THIRD_PARTY_NOTICES.md, parsed. The build turns it into the app's More › About › Open Source Licenses
 * page (tools/v1.ts licensesPatch), and tests/third-party.test.ts checks that every npm package bundled
 * into www/ has a notice.
 *
 * Section format (documented at the top of the file):
 *   ## <Name>
 *   - License: <SPDX expression>
 *   - Packages: <npm name>, <npm name>        optional; defaults to the lower-cased name
 *   ```text
 *   <copyright notice and license text>
 *   ```
 * Sections without a License line or a text block (and HTML comments) are ignored.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Notice {
  name: string;
  license: string;
  packages: string[];
  text: string;
}

export const NOTICES_FILE = path.resolve(import.meta.dirname, '..', 'THIRD_PARTY_NOTICES.md');

export function parseNotices(markdown: string): Notice[] {
  const md = markdown.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const out: Notice[] = [];
  for (const section of md.split(/^## /m).slice(1)) {
    const name = section.slice(0, section.indexOf('\n')).trim();
    const license = /^- License: (.+)$/m.exec(section)?.[1]?.trim();
    const text = /^```text\n([\s\S]*?)\n```$/m.exec(section)?.[1];
    if (!name || !license || text === undefined) continue;
    const listed = /^- Packages: (.+)$/m.exec(section)?.[1];
    const packages = listed ? listed.split(',').map((p) => p.trim()).filter(Boolean) : [name.toLowerCase()];
    out.push({ name, license, packages, text });
  }
  return out;
}

/**
 * License texts are hard-wrapped at ~80 columns; on a phone that leaves ragged half-empty lines. Join
 * the lines of each paragraph so the screen wraps them, but keep line breaks in short structured
 * blocks (a list like "a) …\nb) …", a title over a version line).
 */
export function reflow(text: string): string {
  return text
    .split(/\n[ \t]*\n/)
    .map((para) => {
      const lines = para.split('\n').map((l) => l.trim());
      const structured = lines.length > 1 && lines.every((l) => l.length < 60 || /^([a-z0-9]{1,3}[.)]|[-*•])\s/i.test(l));
      return structured ? lines.join('\n') : lines.join(' ');
    })
    .join('\n\n');
}

export function readNotices(file = NOTICES_FILE): Notice[] {
  return parseNotices(readFileSync(file, 'utf8'));
}

/** npm package names (incl. @scope/name) that appear in esbuild metafile input paths. */
export function packagesFromInputs(inputs: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const input of inputs) {
    const p = input.replace(/\\/g, '/');
    // The last node_modules segment names the package that owns the file (nested copies included).
    const i = p.lastIndexOf('node_modules/');
    if (i < 0) continue;
    const rest = p.slice(i + 'node_modules/'.length).split('/');
    const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : rest[0];
    if (name) found.add(name);
  }
  return [...found].sort();
}
