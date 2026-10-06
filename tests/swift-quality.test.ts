/** CI Swift gates (tools/swift-quality.ts): compiler-warning ratchet and SwiftLint report triage. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { annotation, classifyLint, compareWarnings, countWarnings, formatBaseline, ownPath, parseBaseline, parseWarnings } from '../tools/swift-quality.ts';

const ROOT = '/Users/runner/work/tachinovel-v2/tachinovel-v2';
const LOG = `
CompileSwift normal arm64 ${ROOT}/ios/App/App/Native/Core/CoreHost.swift
${ROOT}/ios/App/App/Native/Core/CoreHost.swift:67:17: warning: capture of 'self' with non-sendable type 'CoreHost' in a '@Sendable' closure [#SendableClosureCaptures]
${ROOT}/ios/App/App/Native/Core/CoreHost.swift:67:17: warning: capture of 'self' with non-sendable type 'CoreHost' in a '@Sendable' closure [#SendableClosureCaptures]
${ROOT}/ios/App/App/Native/Core/CoreHost.swift:90:5: warning: capture of 'self' with non-sendable type 'CoreHost' in a '@Sendable' closure [#SendableClosureCaptures]
${ROOT}/ios/App/App/Native/Narration/SpeechEngine.swift:12:3: warning: var 'x' is never mutated
${ROOT}/node_modules/@capacitor/app/ios/Sources/AppPlugin/AppPlugin.swift:5:1: warning: deprecated
${ROOT}/build/DerivedData/SourcePackages/checkouts/capacitor-swift-pm/ios/App/App/X.swift:1:1: warning: not ours
warning: Run script build phase 'X' will be run during every build
** BUILD SUCCEEDED **
`;

describe('compiler warnings', () => {
  it('keeps only our own Swift files, deduplicated, with repo-relative paths', () => {
    const w = parseWarnings(LOG);
    expect(w.map((x) => `${x.file}:${x.line}`)).toEqual(['ios/App/App/Native/Core/CoreHost.swift:67', 'ios/App/App/Native/Core/CoreHost.swift:90', 'ios/App/App/Native/Narration/SpeechEngine.swift:12']);
    expect(w[0]!.message).toBe("capture of 'self' with non-sendable type 'CoreHost' in a '@Sendable' closure [#SendableClosureCaptures]");
  });

  it('maps paths', () => {
    expect(ownPath(`${ROOT}/ios/App/App/AppDelegate.swift`)).toBe('ios/App/App/AppDelegate.swift');
    expect(ownPath('ios/App/App/AppDelegate.swift')).toBe('ios/App/App/AppDelegate.swift');
    expect(ownPath(`${ROOT}/ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift`)).toBeNull();
    expect(ownPath(`${ROOT}/node_modules/@capacitor/ios/Capacitor/Capacitor/Bridge.swift`)).toBeNull();
  });

  it('round-trips the baseline and ignores line numbers when matching', () => {
    const baseline = parseBaseline(formatBaseline(countWarnings(parseWarnings(LOG))));
    expect([...baseline.values()]).toEqual([2, 1]);
    const moved = parseWarnings(LOG.replace(':90:5:', ':120:5:').replaceAll(':67:17:', ':70:17:'));
    expect(compareWarnings(moved, baseline)).toEqual({ failing: [], reported: [], fixed: new Map() });
  });

  it('fails on a new warning in gated files, only reports one in report-only paths, and notices fixes', () => {
    const baseline = parseBaseline(formatBaseline(countWarnings(parseWarnings(LOG))));
    const extra = `${LOG}\n${ROOT}/ios/App/App/AppDelegate.swift:3:1: warning: new one\n${ROOT}/ios/App/App/Native/Narration/NarrationController.swift:9:9: warning: voice one\n${ROOT}/ios/App/App/Native/Core/CoreHost.swift:91:5: warning: capture of 'self' with non-sendable type 'CoreHost' in a '@Sendable' closure [#SendableClosureCaptures]`;
    const r = compareWarnings(parseWarnings(extra), baseline);
    expect(r.failing.map((w) => `${w.file}:${w.line}`)).toEqual(['ios/App/App/AppDelegate.swift:3', 'ios/App/App/Native/Core/CoreHost.swift:91']);
    expect(r.reported.map((w) => w.file)).toEqual(['ios/App/App/Native/Narration/NarrationController.swift']);

    const fewer = compareWarnings(parseWarnings(LOG.split('\n').filter((l) => !l.includes(':90:5:')).join('\n')), baseline);
    expect(fewer.failing).toEqual([]);
    expect([...fewer.fixed.values()]).toEqual([1]);
  });

  it('the committed baseline parses', () => {
    const text = readFileSync(path.resolve(import.meta.dirname, '..', 'ci', 'swift-warnings-baseline.txt'), 'utf8');
    expect(() => parseBaseline(text)).not.toThrow();
  });
});

describe('SwiftLint report', () => {
  it('gates our files, reports the voice paths, ignores the rest', () => {
    const json = JSON.stringify([
      { file: `${ROOT}/ios/App/App/Native/Core/NativeHTTP.swift`, line: 3, character: 5, rule_id: 'line_length', severity: 'Warning', reason: 'Line should be 160 characters or less' },
      { file: `${ROOT}/ios/App/App/Native/Narration/NarrationController.swift`, line: 1, character: null, rule_id: 'file_length', severity: 'Warning', reason: 'File is too long' },
      { file: `${ROOT}/vendor/whatever.swift`, line: 1, character: 1, rule_id: 'x', severity: 'Error', reason: 'not ours' },
    ]);
    const r = classifyLint(json);
    expect(r.failing).toEqual([{ file: 'ios/App/App/Native/Core/NativeHTTP.swift', line: 3, col: 5, rule: 'line_length', severity: 'warning', reason: 'Line should be 160 characters or less' }]);
    expect(r.reported.map((v) => v.rule)).toEqual(['file_length']);
    expect(classifyLint('[]')).toEqual({ failing: [], reported: [] });
    expect(() => classifyLint('')).toThrow(/no JSON report/);
    expect(() => classifyLint('{"error": 1}')).toThrow(/no JSON report/);
  });

  it('escapes workflow-command annotations', () => {
    expect(annotation('error', 'a,b:c.swift', 1, 2, 'T: x', '50%\nnext')).toBe('::error file=a%2Cb%3Ac.swift,line=1,col=2,title=T%3A x::50%25%0Anext');
  });
});
