/**
 * Third-party notices: THIRD_PARTY_NOTICES.md covers every npm package bundled into the app, and the
 * app's Open Source Licenses page (v1 Licenses screen, patched at build time) shows exactly that file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../tools/build.ts';
import { packagesFromInputs, parseNotices, readNotices, reflow } from '../tools/third-party.ts';

const root = path.resolve(import.meta.dirname, '..');
const out = (flavor: string): string => path.join(root, '.cache', `test-third-party-${flavor}`);
const built: Record<string, { packages: string[]; html: string }> = {};

beforeAll(async () => {
  for (const flavor of ['personal', 'store'] as const) {
    const { packages } = await buildAll({ flavor, ads: false, dev: false, outDir: out(flavor) });
    built[flavor] = { packages, html: readFileSync(path.join(out(flavor), 'index.html'), 'utf8') };
  }
});

describe('THIRD_PARTY_NOTICES.md', () => {
  const notices = readNotices();

  it('parses into named sections with a license and a notice text', () => {
    expect(notices.map((n) => n.name)).toEqual(expect.arrayContaining(['LNReader', 'Capacitor', 'Capacitor plugins', 'Apache Cordova', 'DOMPurify', 'Apache License 2.0']));
    for (const n of notices) {
      expect(n.license, n.name).toMatch(/^[A-Za-z0-9.\-+ ()]+$/);
      expect(n.text.length, n.name).toBeGreaterThan(40);
    }
    expect(notices.find((n) => n.name === 'LNReader')?.text).toContain('Copyright (c) 2021 Rajarshee Chatterjee');
  });

  it('has a notice for every npm package bundled into the app (both flavors)', () => {
    const covered = new Set(notices.flatMap((n) => n.packages));
    for (const flavor of ['personal', 'store']) {
      const packages = built[flavor]!.packages;
      expect(packages.length, flavor).toBeGreaterThan(3);
      const missing = packages.filter((p) => !covered.has(p));
      expect(missing, `${flavor}: add these to THIRD_PARTY_NOTICES.md (with their license) before they ship`).toEqual([]);
    }
  });
});

describe('Open Source Licenses page', () => {
  it('is built from THIRD_PARTY_NOTICES.md in both flavors', () => {
    for (const flavor of ['personal', 'store']) {
      const html = built[flavor]!.html;
      expect(html, flavor).toContain('Drifty Co.');
      expect(html, flavor).toContain('Apache Cordova');
      expect(html, flavor).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    }
  });
});

describe('parser', () => {
  it('skips comments and incomplete sections, and defaults packages to the name', () => {
    const md = [
      '# Notices',
      '<!--\n## Hidden\n- License: MIT\n```text\nx\n```\n-->',
      '## Thing',
      '',
      '- License: MIT',
      '',
      '```text',
      'Copyright (c) Someone',
      '```',
      '## No license',
      '```text',
      'y',
      '```',
      '## Multi',
      '- License: BSD-2-Clause',
      '- Packages: a, @scope/b',
      '```text',
      'z',
      '```',
    ].join('\n');
    expect(parseNotices(md)).toEqual([
      { name: 'Thing', license: 'MIT', packages: ['thing'], text: 'Copyright (c) Someone' },
      { name: 'Multi', license: 'BSD-2-Clause', packages: ['a', '@scope/b'], text: 'z' },
    ]);
  });

  it('reflows hard-wrapped paragraphs for the phone screen and keeps short structured blocks', () => {
    const text = 'MIT License\n\nCopyright (c) 2015 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software, to deal\n  in the Software.\n\neither:\n\na) the Apache License Version 2.0, or\nb) the Mozilla Public License Version 2.0';
    expect(reflow(text)).toBe(
      'MIT License\n\nCopyright (c) 2015 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in the Software.\n\neither:\n\na) the Apache License Version 2.0, or\nb) the Mozilla Public License Version 2.0',
    );
  });

  it('names the package that owns each bundled file', () => {
    expect(
      packagesFromInputs([
        'node_modules/preact/dist/preact.module.js',
        'node_modules/@preact/signals-core/dist/signals-core.mjs',
        'node_modules/htmlparser2/node_modules/entities/dist/esm/decode.js',
        'node_modules\\cheerio\\dist\\esm\\index.js',
        'src/ui/main.ts',
      ]),
    ).toEqual(['@preact/signals-core', 'cheerio', 'entities', 'preact']);
  });
});
