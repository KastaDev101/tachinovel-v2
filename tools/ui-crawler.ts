/**
 * UI crawler (docs/qa.md): taps every control of every reachable screen of the built app in WebKit
 * (iPhone 16 Pro, PC shell + mock native host, seeded synthetic library) and reports what broke.
 *
 * Usage: node tools/ui-crawler.ts [--flavor=personal|store] [--scheme=dark|light|both] [--seed=1]
 *          [--out=.cache/crawler] [--workers=4] [--max-actions=N] [--max-states=N] [--max-minutes=N] [--no-build] [--quiet]
 *        QA_VERBOSE=1 logs every action.
 * Exit code: 1 if there are failures that are not in tests/crawler/known-issues.json, else 0.
 * Output: <out>/report.md, <out>/report.json, <out>/<scheme>/states/*.png, <out>/<scheme>/failures/*.png
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { buildAll, type Flavor } from './build.ts';
import { Crawler } from '../tests/crawler/crawler.ts';
import { CrawlEnv, DEVICE, type Scheme } from '../tests/crawler/env.ts';
import { buildReport, loadKnownIssues, writeReports, type RunReport } from '../tests/crawler/report.ts';

const root = path.resolve(import.meta.dirname, '..');

function arg(name: string, fallback: string): string {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
}

const flavor = arg('flavor', 'personal') as Flavor;
const schemeArg = arg('scheme', 'both');
const schemes: Scheme[] = schemeArg === 'both' ? ['dark', 'light'] : [schemeArg as Scheme];
const seed = Number(arg('seed', '1'));
const outDir = path.resolve(root, arg('out', '.cache/crawler'));
const quiet = process.argv.includes('--quiet');
const wwwDir = path.join(root, '.cache', `crawl-www-${flavor}`);
const workers = Math.max(1, Number(arg('workers', '4')));

const t0 = Date.now();
if (!process.argv.includes('--no-build')) {
  const { info } = await buildAll({ flavor, ads: false, dev: false, outDir: wwwDir });
  console.log(`built ${flavor} ${info.hash} in ${Date.now() - t0} ms`);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const known = loadKnownIssues(path.join(root, 'tests', 'crawler', 'known-issues.json'));

const reports: RunReport[] = [];
for (const scheme of schemes) {
  const started = Date.now();
  const envs = Array.from({ length: workers }, () => new CrawlEnv({ wwwDir, scheme, seed }));
  try {
    await Promise.all(envs.map(async (e) => {
      await e.prepare();
      await e.launch();
    }));
    const crawler = new Crawler(envs, {
      outDir: path.join(outDir, scheme),
      maxStates: Number(arg('max-states', '250')),
      maxActions: Number(arg('max-actions', '5000')),
      maxDepth: 8,
      slowMs: 1500,
      budgetMs: 5000,
      maxWallMs: Number(arg('max-minutes', '25')) * 60_000,
      verbose: !!process.env.QA_VERBOSE,
      ...(quiet ? {} : { log: (l: string) => console.log(`[${scheme}] ${l}`) }),
    });
    await crawler.run();
    let build = 'unknown';
    try {
      build = (JSON.parse(readFileSync(path.join(wwwDir, 'build-info.json'), 'utf8')) as { hash: string }).hash;
    } catch {
      // ignore
    }
    const report = buildReport(crawler, { flavor, scheme, seed, device: DEVICE.name, build, durationMs: Date.now() - started, date: new Date().toISOString() }, known);
    reports.push(report);
    const s = report.stats;
    console.log(
      `[${scheme}] ${s.states} states, ${s.controlsFound} controls found, ${s.controlsTried} activated (${s.sampledOut} repeated rows sampled out, ${s.disabled} disabled, ${s.skipped} skipped for time), ` +
        `${s.actions} actions, ${s.resets} launches, ${s.workers} workers: ${s.failures} failures, ${s.warnings} warnings, ${s.known} known — ${Math.round((Date.now() - started) / 1000)} s`,
    );
  } finally {
    await Promise.all(envs.map((e) => e.close()));
  }
}
writeReports(outDir, reports);
console.log(`report: ${path.relative(root, path.join(outDir, 'report.md'))}`);
const failing = reports.reduce((n, r) => n + r.stats.failures, 0);
process.exit(failing > 0 ? 1 : 0);
