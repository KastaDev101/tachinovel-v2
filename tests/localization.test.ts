/** Native strings: String Catalog + no hard-coded UI strings in Swift (tools/swift-strings.ts). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Catalog, CATALOG, checkStrings, findStrings, formatCatalog, looksHuman, normalizeKey, readCatalog, repoSwift, scanSwift } from '../tools/swift-strings.ts';

const root = path.resolve(import.meta.dirname, '..');
const hardCoded = (src: string): string[] => findStrings(src, 'x.swift').filter((f) => f.kind === 'hard-coded').map((f) => f.text);
const localized = (src: string): string[] => findStrings(src, 'x.swift').filter((f) => f.kind === 'localized').map((f) => f.text);

describe('Swift scanner', () => {
  it('finds literals, skipping comments, and masks them in the code', () => {
    const src = 'let a = "one" // "not this"\n/* "nor /* nested */ this" */ let b = "two \\"q\\" \\(x ? "in" : "out")"\nlet c = #"raw "quoted""#\nlet d = """\n  multi "line"\n  """\n';
    const { code, literals } = scanSwift(src);
    expect(literals.map((l) => l.raw)).toEqual(['one', 'two \\"q\\" \\(x ? "in" : "out")', 'in', 'out', 'raw "quoted"', '\n  multi "line"\n  ']);
    expect(code).toHaveLength(src.length);
    expect(code).not.toMatch(/one|not this|nested|quoted|multi/);
    expect(code).toContain('let b = "');
  });

  it('normalizes interpolations and format specifiers to the same key', () => {
    expect(normalizeKey('\\(count) new chapters')).toBe(normalizeKey('%lld new chapters'));
    expect(normalizeKey('Failed: \\(err.message(for: x))')).toBe(normalizeKey('Failed: %@'));
    expect(normalizeKey('%1$@ of %2$lld')).toBe('%_ of %_');
    expect(looksHuman('\\(a)\\(b)')).toBe(false);
    expect(looksHuman('%@ …')).toBe(false);
    expect(looksHuman('Lädt…')).toBe(true);
  });
});

describe('hard-coded UI strings', () => {
  it('flags literals that reach a UI sink, directly or through an expression or a variable', () => {
    expect(hardCoded('ac.addAction(UIAlertAction(title: "OK", style: .cancel))')).toEqual(['OK']);
    expect(hardCoded('let item = CPListItem(text: "Now Playing", detailText: nil)')).toEqual(['Now Playing']);
    expect(hardCoded('content.title = "New chapters"')).toEqual(['New chapters']);
    expect(hardCoded('content.body = n == 1 ? "One new chapter" : "\\(n) new chapters"')).toEqual(['One new chapter', '\\(n) new chapters']);
    expect(hardCoded('label.accessibilityLabel = "Play"\nbutton.setTitle("Stop", for: .normal)\ntitle = "Voices"')).toEqual(['Play', 'Stop', 'Voices']);
    expect(hardCoded('detail: CPListItem(text: name, detailText: String(format: "Chapter %d", n))')).toEqual(['Chapter %d']);
    expect(hardCoded('if let cancel = opts.cancel ?? (sheet ? "Cancel" : nil) {\n  UIAlertAction(title: cancel, style: .cancel)\n}')).toEqual(['Cancel']);
    expect(hardCoded('let name = e["novelName"] as? String ?? "Novel"\nlet item = CPListItem(text: name, detailText: nil)')).toEqual(['Novel']);
  });

  it('leaves localized strings, logs, identifiers, keys and marked exceptions alone', () => {
    const ok = [
      'UIAlertAction(title: String(localized: "OK", comment: "Dismiss"), style: .cancel)',
      'log.info("core started \\(n) ms")',
      'let log = Logger(subsystem: "app.tachinovel", category: "core")',
      'call.reject("Purchase could not be verified", "STORE")',
      'let item = CPListItem(text: e["chapterName"] as? String, detailText: nil)',
      'CPListTemplate(title: "TachiNovel", sections: []) // l10n-ignore: app name',
      'content.threadIdentifier = "updates"',
      'notify(["title": "Not a sink, a dictionary key"])',
      'let message = exception?.toString() ?? "unknown"\nenvelope(for: json, message: message)',
      'Text("Voices")', // SwiftUI: a LocalizedStringKey already
    ];
    for (const src of ok) expect(hardCoded(src), src).toEqual([]);
  });

  it('collects localized keys with their comments', () => {
    const f = findStrings('let a = String(localized: "\\(n) new chapters",\n    comment: "Notification body")\nText("Voices")\nlet b = String(localized: "No comment")', 'x.swift');
    expect(f).toEqual([
      { file: 'x.swift', line: 1, kind: 'localized', text: '\\(n) new chapters', comment: 'Notification body' },
      { file: 'x.swift', line: 3, kind: 'localized', text: 'Voices' },
      { file: 'x.swift', line: 4, kind: 'localized', text: 'No comment' },
    ]);
    expect(localized('NSLocalizedString("Legacy", comment: "Old API")')).toEqual(['Legacy']);
  });
});

describe('catalog check', () => {
  const catalog = (strings: Catalog['strings']): Catalog => ({ sourceLanguage: 'en', version: '1.0', strings });
  const swift = (file: string, src: string) => ({ file, src });

  it('requires every key with the same comment, and no unused keys', () => {
    const files = [swift('ios/App/App/A.swift', 'let t = String(localized: "\\(n) new chapters", comment: "Body")\nlet u = String(localized: "Done", comment: "Button")')];
    expect(checkStrings(files, catalog({ '%lld new chapters': { comment: 'Body' }, Done: { comment: 'Button' } })).errors).toEqual([]);
    const r = checkStrings(files, catalog({ '%lld new chapters': { comment: 'Other' }, Stale: { comment: 'x' }, NoComment: {} }));
    expect(r.errors.join('\n')).toMatch(/comment of "\\\(n\) new chapters" differs/);
    expect(r.errors.join('\n')).toMatch(/"Done" is not in/);
    expect(r.errors.join('\n')).toMatch(/"Stale" is not used/);
    expect(r.errors.join('\n')).toMatch(/"NoComment" has no comment/);
  });

  it("reports another workstream's paths without failing", () => {
    const r = checkStrings([swift('ios/App/App/Native/Voice/VoiceLab.swift', 'label.text = "Voice Lab"')], catalog({}));
    expect(r.errors).toEqual([]);
    expect(r.notes).toHaveLength(1);
  });
});

describe('this repository', () => {
  it('has no hard-coded UI strings and a complete catalog', () => {
    const r = checkStrings(repoSwift(), readCatalog());
    expect(r.errors).toEqual([]);
    expect(r.keys).toBeGreaterThan(0);
  });

  it("keeps the catalog in Xcode's layout (node tools/swift-strings.ts --format)", () => {
    const text = readFileSync(path.join(root, CATALOG), 'utf8');
    expect(text).toBe(`${formatCatalog(JSON.parse(text))}\n`);
  });

  it('ships the catalog in the app (node tools/ios-project.ts)', () => {
    const pbx = readFileSync(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).toMatch(/\/\* Localizable\.xcstrings in Resources \*\/,/);
    expect(pbx.match(/LOCALIZATION_PREFERS_STRING_CATALOGS = YES;/g)).toHaveLength(2);
  });
});
