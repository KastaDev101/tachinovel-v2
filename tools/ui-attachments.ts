/**
 * Tidies `xcrun xcresulttool export attachments` output for the "ui-test-screenshots" artifact
 * (ci/ios-ui-tests.sh): files come out named by UUID with a manifest.json. Keeps the test's own named
 * screenshots ("03-restored.png"), its text attachments, Xcode's failure hierarchy and the screen
 * recording, under readable names; drops the automatic per-step "UI Snapshot" / "Synthesized Event" files.
 *
 * Usage: node tools/ui-attachments.ts <export-dir>
 */
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

interface Attachment {
  exportedFileName: string;
  suggestedHumanReadableName: string;
}

/** "03-restored_0_7B119B3E-….png" → "03-restored.png"; null = drop. */
export function readableName(suggested: string, exported: string): string | null {
  if (/^(UI Snapshot|Synthesized Event)/.test(suggested)) return null;
  if (/^Screen Recording/.test(suggested)) return `screen-recording${path.extname(exported) || '.mp4'}`;
  const ext = path.extname(exported) || path.extname(suggested) || '.txt';
  const base = suggested.replace(/_\d+_[0-9A-F-]{36}(\.[^.]*)?$/i, '').replace(/\.[a-z0-9]+$/i, '');
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'attachment';
  return `${safe}${ext}`;
}

export function tidy(dir: string): string[] {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { attachments?: Attachment[] }[];
  const kept: string[] = [];
  const used = new Set<string>();
  for (const test of manifest) {
    for (const a of test.attachments ?? []) {
      const from = path.join(dir, a.exportedFileName);
      if (!existsSync(from)) continue;
      const name = readableName(a.suggestedHumanReadableName, a.exportedFileName);
      if (!name) {
        rmSync(from, { force: true });
        continue;
      }
      let unique = name;
      for (let n = 2; used.has(unique); n++) unique = name.replace(/(\.[^.]*)?$/, `-${n}$1`);
      used.add(unique);
      renameSync(from, path.join(dir, unique));
      kept.push(unique);
    }
  }
  return kept.sort();
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node tools/ui-attachments.ts <export-dir>');
    process.exit(2);
  }
  for (const name of tidy(path.resolve(dir))) console.log(name);
}
