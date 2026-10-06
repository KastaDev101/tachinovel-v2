/** CI "changes" filter (tools/ci-changes.ts): which pull requests may skip the macOS jobs. */
import { describe, expect, it } from 'vitest';
import { appChanged, isDocsOnlyFile } from '../tools/ci-changes.ts';

describe('docs-only pull requests', () => {
  it('treats docs, Markdown, changelog fragments and PR/issue templates as docs-only', () => {
    for (const f of ['docs/roadmap.md', 'docs/legal/terms.md', 'README.md', 'CONTRIBUTING.md', 'changelog.d/x.md', '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug.yml', 'ios/App/CapApp-SPM/README.md']) {
      expect(isDocsOnlyFile(f), f).toBe(true);
    }
  });

  it('runs the macOS jobs for anything else, including the notices the app shows', () => {
    for (const f of ['THIRD_PARTY_NOTICES.md', 'src/ui/main.ts', 'ios/App/App/AppDelegate.swift', '.github/workflows/ios.yml', 'package.json', 'LICENSE', 'ci/ios-sim-smoke.sh']) {
      expect(isDocsOnlyFile(f), f).toBe(false);
    }
    expect(appChanged(['docs/a.md', 'README.md'])).toBe(false);
    expect(appChanged(['docs/a.md', 'src/core/core.ts'])).toBe(true);
    expect(appChanged([])).toBe(true);
  });
});
