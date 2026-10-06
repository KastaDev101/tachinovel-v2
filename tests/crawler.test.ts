/** Unit tests for the UI crawler's deterministic pieces (the crawl itself: `node tools/ui-crawler.ts`). */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Finding } from './crawler/crawler.ts';
import { deviceHtml, DEVICE, inlineScript } from './crawler/env.ts';
import { createFakeWeb, LNREADER_REPO, STONESCAPE } from './crawler/fake-web.ts';
import { markdown, matchKnown, type KnownIssue, type RunReport } from './crawler/report.ts';

describe('synthetic web', () => {
  it('is identical for the same seed', () => {
    const a = createFakeWeb(7);
    const b = createFakeWeb(7);
    for (const url of ['https://novels.example.test/novel/alpha', 'https://novels.example.test/novel/alpha/3', `${STONESCAPE}/api/series?page=1&limit=20&contentType=novel`]) {
      expect(a.route({ url }).body).toBe(b.route({ url }).body);
    }
    expect(a.misses).toEqual([]);
  });

  it('serves the demo site, Stonescape API, the LNReader index and PNG covers', () => {
    const web = createFakeWeb(1);
    expect(web.route({ url: 'https://novels.example.test/popular?page=1' }).body).toContain('Alpha Story');
    expect(web.route({ url: 'https://novels.example.test/popular?page=2' }).body).not.toContain('novel-item');
    expect(web.route({ url: 'https://novels.example.test/search?q=lantern&page=1' }).body).toContain('The Lantern Keeper');
    const locked = web.demo[0]?.chapters.find((c) => c.locked);
    expect(web.route({ url: `https://novels.example.test/novel/alpha/${locked?.n}` }).body).toContain('paywall');
    const series = JSON.parse(web.route({ url: `${STONESCAPE}/api/series?page=1&limit=20&contentType=novel&search=glass` }).body ?? '{}') as { data: { slug: string }[] };
    expect(series.data.map((s) => s.slug)).toEqual(['glass-orchard']);
    expect(web.route({ url: `${STONESCAPE}/api/series/by-slug/shadow-tide/chapters/80.00/novel-content` }).status).toBe(402);
    const index = JSON.parse(web.route({ url: LNREADER_REPO }).body ?? '[]') as { id: string; url: string }[];
    expect(index.length).toBeGreaterThan(0);
    expect(web.route({ url: index[0]?.url ?? '' }).body).toContain('exports.default');
    const png = web.route({ url: 'https://novels.example.test/covers/alpha.png' }).bytes;
    expect(Buffer.from(png ?? []).subarray(1, 4).toString('latin1')).toBe('PNG');
    web.route({ url: 'https://elsewhere.example.test/x' });
    expect(web.misses).toEqual(['GET https://elsewhere.example.test/x']);
  });

  it('publish() releases the held-back chapters (Updates)', () => {
    const web = createFakeWeb(1);
    const before = web.demo[0]?.chapters.length ?? 0;
    web.publish();
    expect(web.demo[0]?.chapters.length).toBeGreaterThan(before);
  });
});

describe('device HTML', () => {
  it('rewrites safe-area insets and keeps the CSP script hash valid', () => {
    const js = 'document.body.style.paddingTop="env(safe-area-inset-top)";';
    const hash = createHash('sha256').update(js, 'utf8').digest('base64');
    const html = `<meta http-equiv="Content-Security-Policy" content="script-src 'sha256-${hash}'"><style>a{bottom:env(safe-area-inset-bottom, 0px)}</style><script>${js}</script>`;
    const out = deviceHtml(html);
    expect(out).not.toContain('env(safe-area');
    expect(out).toContain(`bottom:${DEVICE.safe.bottom}px`);
    const newJs = inlineScript(out) ?? '';
    expect(newJs).toContain(`"${DEVICE.safe.top}px"`);
    expect(out).toContain(`'sha256-${createHash('sha256').update(newJs, 'utf8').digest('base64')}'`);
  });
});

describe('report', () => {
  const finding: Finding = { kind: 'dead-control', severity: 'fail', state: 'tabs:more', control: 'About', message: 'tapping "About" changed nothing', repro: ['tap "More"'], count: 1 };

  it('matches known issues by kind and regexes', () => {
    const known: KnownIssue[] = [
      { id: 'v1-about', kind: 'dead-control', control: '^About$', owner: 'v1', note: 'x' },
      { id: 'other', kind: 'layout', owner: 'v2', note: 'y' },
    ];
    expect(matchKnown(finding, known)?.id).toBe('v1-about');
    expect(matchKnown({ ...finding, control: 'Abouts' }, known)).toBeUndefined();
  });

  it('renders failures first with repro steps', () => {
    const report: RunReport = {
      meta: { flavor: 'personal', scheme: 'dark', seed: 1, device: 'iPhone 16 Pro', build: 'abc', durationMs: 1000, date: '2026-10-06T00:00:00Z' },
      stats: { states: 1, actions: 1, resets: 1, controlsFound: 1, controlsTried: 1, sampledOut: 0, disabled: 0, skipped: 0, workers: 1, failures: 1, warnings: 0, known: 0 },
      findings: [{ ...finding, kind: 'slow', severity: 'warn' }, finding],
      states: [{ index: 1, sig: 'tabs:more', path: [], found: 1, sampledOut: 0, controls: [], layout: [] }],
      edges: [],
      unusedKnown: ['old-one'],
    };
    const md = markdown([report]);
    expect(md.indexOf('**FAIL**')).toBeLessThan(md.indexOf('| warn |'));
    expect(md).toContain('tap "More"');
    expect(md).toContain('`old-one`');
  });
});
