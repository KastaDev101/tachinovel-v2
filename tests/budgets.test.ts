/** CI budgets (tools/budgets.ts, ci/budgets.json). */
import { describe, expect, it } from 'vitest';
import { annotation, checkBoot, checkIpa, loadBudgets, median, parseBootTimes, setIpaBaseline } from '../tools/budgets.ts';

const IPA = { baselineBytes: 100_000_000, maxGrowthPercent: 10 };
const BOOT = { metric: 'process->library', recordedMedianMs: 2694, warnAboveMs: 4000 };

// boot-times.txt as ci/ios-sim-smoke.sh writes it (column set from the boot report, PR #26).
const REPORT = `launch                       tap->process   process->WebView      WebView->HTML          HTML->DOM      DOM->app.boot  app.boot->library   process->library       tap->library  (ms)
1-first-launch          no boot line (library not painted within 20 s of the page starting?)
2-relaunch                       1890                512                 40                 12                  3               1610               2177               4067
3-library                        1720                498                 38                 11                  3               2190               2740               4460
4-reader                            -                520                 41                 12                  3               2380               2944                  -
`;

describe('IPA size budget', () => {
  it('passes within the budget and fails above it with how to raise the baseline', () => {
    expect(checkIpa(105_000_000, IPA)).toMatchObject({ level: 'ok', message: expect.stringContaining('+5.0%') as unknown });
    expect(checkIpa(110_000_000, IPA).level).toBe('ok');
    const over = checkIpa(110_000_001, IPA);
    expect(over.level).toBe('error');
    expect(over.message).toContain('node tools/budgets.ts set-ipa 110000001');
  });

  it('asks for a lower baseline when the IPA shrank a lot, and only reports without a baseline', () => {
    expect(checkIpa(85_000_000, IPA).level).toBe('warning');
    expect(checkIpa(95_000_000, IPA).level).toBe('ok');
    expect(checkIpa(12_345, { ...IPA, baselineBytes: null })).toMatchObject({ level: 'notice', message: expect.stringContaining('set-ipa 12345') as unknown });
  });

  it('records a baseline in bytes only', () => {
    const b = loadBudgets();
    expect(setIpaBaseline(b, 97_000_000).ipa.baselineBytes).toBe(97_000_000);
    expect(setIpaBaseline(b, 97_000_000).boot).toEqual(b.boot);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => setIpaBaseline(b, bad)).toThrow();
  });
});

describe('boot time soft budget', () => {
  it('reads one column of the boot report, skipping launches without a value', () => {
    expect(parseBootTimes(REPORT, 'process->library')).toEqual([2177, 2740, 2944]);
    expect(parseBootTimes(REPORT, 'tap->library')).toEqual([4067, 4460]);
    expect(parseBootTimes(REPORT.replace(/\n/g, '\r\n'), 'process->library')).toEqual([2177, 2740, 2944]);
    // The report before PR #26 has no process->library column: nothing to check.
    expect(parseBootTimes('launch                 tap->WebView  WebView->library  tap->library (ms)\n2-relaunch   900  3000  3900\n', 'process->library')).toEqual([]);
    expect(parseBootTimes('', 'process->library')).toEqual([]);
  });

  it('warns over the budget and never fails', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(checkBoot([2177, 2740, 2944], BOOT)).toMatchObject({ level: 'ok', message: expect.stringContaining('median 2740 ms (n=3)') as unknown });
    expect(checkBoot([4100, 4200, 3900], BOOT).level).toBe('warning');
    expect(checkBoot([], BOOT).level).toBe('notice');
  });
});

describe('budget files and annotations', () => {
  it('ci/budgets.json is well formed', () => {
    const b = loadBudgets();
    expect(b.ipa.baselineBytes === null || (Number.isInteger(b.ipa.baselineBytes) && b.ipa.baselineBytes > 0)).toBe(true);
    expect(b.ipa.maxGrowthPercent).toBe(10);
    expect(b.boot.warnAboveMs).toBeGreaterThan(b.boot.recordedMedianMs);
    expect(b.boot.metric).toBe('process->library');
  });

  it('escapes workflow command properties and data', () => {
    expect(annotation('warning', 'Boot time (simulator, cold): x', '5% over\nnext')).toBe('::warning title=Boot time (simulator%2C cold)%3A x::5%25 over%0Anext');
    expect(annotation('ok', 'IPA', 'fine')).toBe('::notice title=IPA::fine');
  });
});
