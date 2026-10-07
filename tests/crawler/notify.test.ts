/** tools/crawler-notify.ts: which crawler failures the scheduled run reports to the tracking issue. */
import { describe, expect, it } from 'vitest';
import type { Finding } from './crawler.ts';
import type { RunReport } from './report.ts';
import { failureId, notify } from '../../tools/crawler-notify.ts';

const finding = (over: Partial<Finding>): Finding => ({
  kind: 'dead-control',
  severity: 'fail',
  state: 'tabs:more > settings:about',
  control: 'Version',
  message: 'tapping "Version" changed nothing',
  repro: ['tap "More"', 'tap "About"', 'tap "Version"'],
  count: 1,
  ...over,
});

const report = (scheme: string, findings: Finding[]): RunReport => ({
  meta: { flavor: 'personal', scheme, seed: 1, device: 'iPhone 16 Pro', build: 'abc', durationMs: 1, date: '2026-10-06T00:00:00Z' },
  stats: { states: 1, actions: 1, resets: 1, controlsFound: 1, controlsTried: 1, sampledOut: 0, disabled: 0, skipped: 0, workers: 1, failures: 0, warnings: 0, known: 0 },
  findings,
  states: [],
  edges: [],
  unusedKnown: [],
});

describe('crawler-notify', () => {
  it('reports unknown failures once, with a stable id per screen (not per path)', () => {
    const a = finding({});
    const sameScreenOtherPath = finding({ state: 'tabs:library > novel > settings:about' });
    expect(failureId(a)).toBe(failureId(sameScreenOtherPath));
    const r = notify([report('dark', [a, finding({ severity: 'warn', kind: 'slow' }), finding({ known: 'v1-x', control: 'Reset' })])], '', 'https://run');
    expect(r).toMatchObject({ failures: 1, new: 1 });
    expect(r.body).toContain('tap "About" → tap "Version"');
    expect(r.body).toContain(`<!-- crawler-id:${failureId(a)} -->`);
    // Already in the issue: not new again; the same failure in light mode isn't new either.
    const again = notify([report('dark', [a]), report('light', [a])], r.body, 'https://run2');
    expect(again).toMatchObject({ failures: 2, new: 0, body: '' });
  });

  it('a clean run reports nothing new and zero failures', () => {
    expect(notify([report('dark', []), report('light', [finding({ severity: 'warn' })])], '', 'u')).toEqual({ failures: 0, new: 0, body: '' });
  });
});
