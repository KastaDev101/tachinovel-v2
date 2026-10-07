/**
 * CI job "changes" (.github/workflows/ios.yml): which macOS jobs can a pull request tell us anything
 * with? Free public repos get only a few macOS runners at a time, so each PR runs only the jobs its files
 * can affect. A skipped job counts as passing a required check. Pushes, tags and manual runs always run
 * everything, and so does any PR that changes the workflow itself.
 *
 *   app    ios-compile + simulator smoke: anything but docs (docs/**, *.md except THIRD_PARTY_NOTICES.md,
 *          which the app shows, changelog.d/**, PR/issue templates) and files no macOS job can affect
 *          (the UI crawler: tests/crawler/**, its tools and workflow; this filter and its test).
 *   ui     ios-ui-tests: app code (src/, ios/, vendor/), what builds the bundle (package*.json,
 *          capacitor config, tools/build.ts, tools/v1.ts) or the UI test's own fixtures and scripts.
 *   ipa    ios-ipa: native code (ios/, not the UI test target), what goes into the device build
 *          (package*.json, capacitor config, build/IPA scripts, the voice model fetch) or the IPA budget.
 *   voice  voice-quality and voice-simulator: the voice engine (ios/App/HDVoice, ios/App/ExpressiveVoice,
 *          Native/Voice, Native/Narration, the model lock), its UI (src/ui/native/voice*, narration*, speech*), the
 *          narration script (src/core/narration), the model fetch and fixture scripts and their tests.
 *
 *   node tools/ci-changes.ts <base-ref>    pull request: compare <base-ref>...HEAD
 *   node tools/ci-changes.ts --all         push/tag/manual: everything runs
 * Writes app=, ui=, ipa=, voice= (true|false) to $GITHUB_OUTPUT. Fails safe: on any error, all true.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export function isDocsOnlyFile(file: string): boolean {
  const f = file.replace(/\\/g, '/');
  if (f === 'THIRD_PARTY_NOTICES.md') return false; // built into the app's licenses page
  return (
    f.startsWith('docs/') ||
    f.startsWith('changelog.d/') ||
    f.toLowerCase().endsWith('.md') ||
    f.startsWith('.github/ISSUE_TEMPLATE/') ||
    f.startsWith('.github/PULL_REQUEST_TEMPLATE/') ||
    /^\.github\/pull_request_template\.md$/i.test(f)
  );
}

/**
 * Files no macOS job can tell anything about: the UI crawler (its own Ubuntu workflow) and this filter
 * (unit-tested in the web job; main always runs everything anyway).
 */
const NO_MACOS_IMPACT = [
  /^tests\/crawler\//,
  /^tools\/(ui-crawler|crawler-notify)\.ts$/,
  /^\.github\/workflows\/ui-crawler\.yml$/,
  /^tools\/ci-changes\.ts$/,
  /^tests\/ci-changes\.test\.ts$/,
];

/** Docs, or one of the files above: no macOS job needs to run for it. */
export function skipsMacJobs(file: string): boolean {
  const f = file.replace(/\\/g, '/');
  return isDocsOnlyFile(f) || NO_MACOS_IMPACT.some((r) => r.test(f));
}

/** True when the macOS jobs should run for these changed files (no files: run, to be safe). */
export function appChanged(files: string[]): boolean {
  return files.length === 0 || files.some((f) => !skipsMacJobs(f));
}

const BUNDLE = [/^package(-lock)?\.json$/, /^capacitor\.config\.[a-z]+$/, /^tools\/(build|v1)\.ts$/];
/** Changing the workflow runs every job (its job definitions are what changed). */
const EVERYTHING = [/^\.github\/workflows\/ios\.yml$/];

export const RULES = {
  ui: [/^src\//, /^ios\//, /^vendor\//, ...BUNDLE, /^ci\/ios-ui-tests\.sh$/, /^tools\/ui-(fixtures|attachments)\.ts$/, /^tests\/fixtures\/demo-site\//],
  ipa: [/^ios\/(?!App\/AppUITests\/)/, ...BUNDLE, /^tools\/(ios-project|fetch-voices|budgets)\.ts$/, /^ci\/(ios-unsigned-ipa|ipa-size)\.sh$/, /^ci\/budgets\.json$/],
  voice: [
    /^ios\/App\/(HDVoice|ExpressiveVoice)\//,
    /^ios\/App\/App\/Native\/(Voice|Narration)\//,
    /^ios\/kokoro-models\.lock\.json$/,
    /^src\/ui\/native\/(voice|narration|speech)[^/]*\.ts$/,
    /^src\/core\/narration\//,
    /^tools\/(fetch-voices|voice-fixtures[^/]*)\.ts$/,
    /^tests\/voice[^/]*$/,
    /^ci\/(voice-[^/]*|ios-voice-selftest)\.sh$/,
  ],
} as const;

export interface Changes {
  app: boolean;
  ui: boolean;
  ipa: boolean;
  voice: boolean;
}

const ALL: Changes = { app: true, ui: true, ipa: true, voice: true };

/** Which job groups these changed files need (no files: everything, to be safe). */
export function classify(files: string[]): Changes {
  const norm = files.map((f) => f.replace(/\\/g, '/'));
  if (norm.length === 0 || norm.some((f) => EVERYTHING.some((r) => r.test(f)))) return { ...ALL };
  const any = (rules: readonly RegExp[]): boolean => norm.some((f) => rules.some((r) => r.test(f)));
  const app = appChanged(norm);
  return { app, ui: app && any(RULES.ui), ipa: app && any(RULES.ipa), voice: app && any(RULES.voice) };
}

function output(c: Changes, why: string): void {
  const line = `app=${c.app} ui=${c.ui} ipa=${c.ipa} voice=${c.voice}`;
  console.log(`${line} (${why})`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${line.replace(/ /g, '\n')}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const mark = (b: boolean): string => (b ? 'runs' : 'skipped');
    const rows = [
      ['ios-compile + simulator smoke', c.app],
      ['ios-ui-tests', c.ui],
      ['ios-ipa', c.ipa],
      ['voice-quality, voice-simulator', c.voice],
    ] as const;
    appendFileSync(summary, `### macOS jobs for this run\n\n${why}\n\n| Job | |\n|---|---|\n${rows.map(([job, on]) => `| ${job} | ${mark(on)} |`).join('\n')}\n`);
  }
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg || arg === '--all') {
    output(ALL, 'push, tag or manual run: everything runs');
  } else {
    try {
      const files = execFileSync('git', ['diff', '--name-only', `${arg}...HEAD`], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
      const c = classify(files);
      const why = files.length === 0 ? 'no changed files found: running everything' : c.app ? `${files.length} changed file(s)` : `no macOS impact (docs, UI crawler, this filter): ${files.length} file(s)`;
      output(c, why);
    } catch (err) {
      output(ALL, `could not diff against ${arg}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
}
