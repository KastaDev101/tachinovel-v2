/**
 * CI job "changes" (.github/workflows/ios.yml): does this pull request touch anything the macOS jobs
 * (simulator build + smoke, device IPA, UI tests) can tell us about? Docs-only PRs skip them; a skipped
 * job counts as passing a required check. Pushes, tags and manual runs always run everything.
 *
 * Docs-only = every changed file is one of: docs/**, *.md (anywhere, except THIRD_PARTY_NOTICES.md,
 * which the app shows), changelog.d/**, the PR template or issue templates under .github/.
 *
 *   node tools/ci-changes.ts <base-ref>    pull request: compare <base-ref>...HEAD
 *   node tools/ci-changes.ts --all         push/tag/manual: everything runs
 * Writes app=true|false to $GITHUB_OUTPUT. Fails safe: on any error it reports app=true.
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

/** True when the macOS jobs should run for these changed files (no files: run, to be safe). */
export function appChanged(files: string[]): boolean {
  return files.length === 0 || files.some((f) => !isDocsOnlyFile(f));
}

function output(app: boolean, why: string): void {
  console.log(`app=${app} (${why})`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `app=${app}\n`);
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg || arg === '--all') {
    output(true, 'push, tag or manual run: everything runs');
  } else {
    try {
      const files = execFileSync('git', ['diff', '--name-only', `${arg}...HEAD`], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
      const app = appChanged(files);
      const why = files.length === 0 ? 'no changed files found: running everything' : app ? `${files.filter((f) => !isDocsOnlyFile(f)).length} app/build file(s) changed` : `docs-only: ${files.length} file(s)`;
      output(app, why);
    } catch (err) {
      output(true, `could not diff against ${arg}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
}
