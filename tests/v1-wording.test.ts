/**
 * tools/v1-wording.ts: every wording patch matches exactly once in the vendored v1 UI, and the patched
 * files no longer name Scriptable, iCloud Drive paths or BookPlayer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PC_NARRATOR_PATCHES } from '../tools/v1.ts';
import { wordingPatches } from '../tools/v1-wording.ts';

const src = path.resolve(import.meta.dirname, '..', 'vendor', 'v1', 'src');

describe('v1 wording patches', () => {
  const patches = wordingPatches();
  const files = [...new Set(patches.map((p) => p.file))];

  it.each(patches.map((p) => [p.why, p] as const))('%s: matches exactly once', (_why, p) => {
    const text = readFileSync(path.join(src, p.file), 'utf8').replace(/\r\n/g, '\n');
    const all = text.match(new RegExp(p.find.source, `${p.find.flags.replace('g', '')}g`)) ?? [];
    expect(all).toHaveLength(1);
  });

  it.each(PC_NARRATOR_PATCHES.map((p) => [p.why, p] as const))('%s: the stub replaces the whole file, once', (_why, p) => {
    const text = readFileSync(path.join(src, p.file), 'utf8').replace(/\r\n/g, '\n');
    expect(text.match(new RegExp(p.find.source, `${p.find.flags.replace('g', '')}g`)) ?? []).toHaveLength(1);
    expect(text.replace(p.find, p.replace)).toMatch(/^\/\*\* Stubbed out by tools\/v1\.ts[^\n]*\nexport function Narration(Screen|Card)\(/);
  });

  it.each(files)('%s: no Scriptable, iCloud Drive path or BookPlayer left in user-visible text', (file) => {
    let text = readFileSync(path.join(src, file), 'utf8').replace(/\r\n/g, '\n');
    for (const p of patches.filter((x) => x.file === file)) text = text.replace(p.find, p.replace);
    // Comments may still explain v1; strings and JSX text may not.
    const code = text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/Scriptable|BookPlayer|iCloud Drive ›/);
  });
});
