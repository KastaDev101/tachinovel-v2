/** CI "changes" filter (tools/ci-changes.ts): which pull requests may skip the macOS jobs. */
import { describe, expect, it } from 'vitest';
import { appChanged, classify, isDocsOnlyFile } from '../tools/ci-changes.ts';

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

describe('per-job gates', () => {
  it('runs everything for pushes-like input and for the workflow itself', () => {
    const all = { app: true, ui: true, ipa: true, voice: true };
    expect(classify([])).toEqual(all);
    expect(classify(['.github/workflows/ios.yml'])).toEqual(all);
  });

  it('skips every macOS job for docs, the UI crawler and this filter', () => {
    const none = { app: false, ui: false, ipa: false, voice: false };
    expect(classify(['docs/a.md', 'changelog.d/x.md'])).toEqual(none);
    expect(classify(['tests/crawler/crawler.ts', 'tests/crawler/known-issues.json', 'tools/ui-crawler.ts', 'tools/crawler-notify.ts', '.github/workflows/ui-crawler.yml', 'docs/qa.md'])).toEqual(none);
    expect(classify(['tools/ci-changes.ts', 'tests/ci-changes.test.ts', 'CONTRIBUTING.md'])).toEqual(none);
    // …but not together with something that does reach the app.
    expect(classify(['tests/crawler/crawler.ts', 'src/ui/main.ts'])).toMatchObject({ app: true, ui: true });
    expect(classify(['tools/ui-crawler.ts', 'tests/crawler-helpers.ts'])).toMatchObject({ app: true });
  });

  it('tests- and tools-only changes build and smoke-test, nothing more', () => {
    expect(classify(['tests/release.test.ts', 'tools/release.ts', '.github/workflows/release.yml'])).toEqual({ app: true, ui: false, ipa: false, voice: false });
    expect(classify(['tests/shell/a11y.shell.ts', 'tools/swift-strings.ts'])).toEqual({ app: true, ui: false, ipa: false, voice: false });
  });

  it('web UI changes run the UI test, not the device build', () => {
    expect(classify(['src/ui/native/diagnostics-overlay.ts'])).toEqual({ app: true, ui: true, ipa: false, voice: false });
    expect(classify(['vendor/v1/src/ui/app.tsx'])).toMatchObject({ ui: true, ipa: false });
    expect(classify(['tools/ui-fixtures.ts'])).toMatchObject({ ui: true, ipa: false });
  });

  it('native and bundle changes run the device build', () => {
    expect(classify(['ios/App/App/Native/Core/NativeUI.swift'])).toEqual({ app: true, ui: true, ipa: true, voice: false });
    expect(classify(['package-lock.json'])).toMatchObject({ ui: true, ipa: true });
    expect(classify(['ci/ios-unsigned-ipa.sh'])).toEqual({ app: true, ui: false, ipa: true, voice: false });
    expect(classify(['ci/budgets.json', 'tools/budgets.ts'])).toMatchObject({ ipa: true, ui: false });
    // The UI test target isn't in the app: it needs the UI test, not a device build.
    expect(classify(['ios/App/AppUITests/AppUITests.swift', 'ci/ios-ui-tests.sh'])).toEqual({ app: true, ui: true, ipa: false, voice: false });
  });

  it('voice code, its UI, the model fetch and their tests run the voice jobs', () => {
    for (const f of [
      'ios/App/HDVoice/Sources/HDVoiceCore/PCM.swift',
      'ios/App/ExpressiveVoice/Sources/ExpressiveCore/VoicePack.swift',
      'ios/App/App/Native/Voice/KokoroService.swift',
      'ios/App/App/Native/Narration/NarrationController.swift',
      'ios/kokoro-models.lock.json',
      'src/ui/native/voices-ui.ts',
      'src/ui/native/voice-lab.ts',
      'src/ui/native/narration-overlay.ts',
      'src/ui/native/speech-dom.ts',
      'src/core/narration/speech-script.ts',
      'tools/fetch-voices.ts',
      'tools/voice-fixtures-lib.ts',
      'tests/voice.test.ts',
      'ci/voice-check.sh',
      'ci/ios-voice-selftest.sh',
    ]) {
      expect(classify([f]).voice, f).toBe(true);
    }
    for (const f of ['src/ui/native/car-mode.ts', 'ios/App/App/Native/Core/CoreHost.swift', 'tests/release.test.ts', 'src/core/core.ts']) {
      expect(classify([f]).voice, f).toBe(false);
    }
  });
});
