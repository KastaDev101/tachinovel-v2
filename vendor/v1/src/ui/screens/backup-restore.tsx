/**
 * Restore, step 2: what the backup holds (from `backup.preview`) and how to apply it. Merge is the
 * recommended choice; Replace asks once more. A picked file is restored by its importId (single use,
 * expires after a few minutes), so the user never picks twice; if it has expired, "Pick Again".
 */
import { useState } from 'preact/hooks';
import type { BackupPreview } from '../../shared/contracts/protocol.ts';
import { bridge, errorText, toUiError } from '../bridge/client.ts';
import { Button } from '../components/controls.tsx';
import { Icon } from '../components/icon.tsx';
import { Sheet } from '../components/sheet.tsx';
import { backupContents, backupSkipped, backupWhen } from '../lib/backup-preview.ts';
import { plural } from '../lib/format.ts';
import { actionSheet, confirmAlert } from '../state/actions.ts';
import { categories, library, progressVersion, reloadLibrary, reloadSources, settings } from '../state/store.ts';
import { errorToast, showToast } from '../state/toast.ts';
import '../styles/extras.css';

/**
 * Categories and settings only arrive with app.boot, so refetch them after a restore. Otherwise the
 * next categories.save / settings.set would send the stale pre-restore copies back and undo it.
 */
export async function reloadRestoredState(): Promise<void> {
  try {
    const [cats, fresh] = await Promise.all([bridge().call('categories.list'), bridge().call('settings.set', { patch: {} })]);
    categories.value = cats;
    settings.value = fresh;
  } catch {
    // Keep what we have; the library and sources were still reloaded.
  }
}

/** Which backup to restore: a listed one by fileName, a picked one by importId (never both). */
export function restoreTarget(p: BackupPreview): { fileName: string } | { importId: string } | null {
  if (p.importId !== undefined) return { importId: p.importId };
  if (p.fileName !== undefined) return { fileName: p.fileName };
  return null;
}

export function RestoreSheet(props: { open: boolean; preview: BackupPreview; onClose: () => void; onPickAgain: () => void }) {
  const p = props.preview;
  const [busy, setBusy] = useState<'merge' | 'replace' | null>(null);
  const [error, setError] = useState<{ message: string; pickAgain: boolean } | null>(null);
  const skipped = backupSkipped(p);

  async function restore(mode: 'merge' | 'replace'): Promise<void> {
    const target = restoreTarget(p);
    if (!target || busy) return;
    if (mode === 'replace' && !(await confirmAlert('Replace everything?', 'Your current library, progress, history and settings will be replaced by the backup. This can’t be undone.', 'Replace'))) return;
    setBusy(mode);
    setError(null);
    try {
      const r = await bridge().call('backup.restore', { mode, ...target }, { timeoutMs: 300_000 });
      await Promise.all([reloadLibrary(), reloadSources(), reloadRestoredState()]);
      progressVersion.value++;
      props.onClose();
      showToast(`Restored ${plural(r.novels, 'novel')} and ${plural(r.sources, 'source')}`, { durationMs: 4000 });
    } catch (err) {
      const ui = toUiError(err);
      // A picked file that's gone (used or expired): say so, and offer to pick it again.
      const gone = 'importId' in target && ui.code === 'NOT_FOUND';
      // The script says what happened ("…expired; pick it again"), which beats a generic "Not found".
      setError({ message: gone && ui.message ? ui.message : errorText(ui), pickAgain: gone });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Restore Backup" detents={['fit']} testId="restore-sheet">
      <div class="restore">
        <div class="restore-summary">
          <span class="restore-icon" aria-hidden="true">
            <Icon name="doc.text" size={26} />
          </span>
          <p class="restore-when" data-testid="restore-when">
            {backupWhen(p.createdAt, Date.now())}
          </p>
          <p class="restore-contents" data-testid="restore-contents">
            {backupContents(p)}
          </p>
          {skipped && (
            <p class="restore-skipped" data-testid="restore-skipped">
              <Icon name="exclamationmark.triangle" size={15} />
              <span>{skipped}. They’ll be left out.</span>
            </p>
          )}
        </div>

        {error && (
          <div class="restore-error" role="alert" data-testid="restore-error">
            <p>{error.message}</p>
            {error.pickAgain && (
              <Button variant="tinted" size="small" onClick={props.onPickAgain}>
                Pick Again
              </Button>
            )}
          </div>
        )}

        <div class="restore-actions">
          <Button variant="filled" size="large" onClick={() => void restore('merge')} disabled={busy !== null}>
            {busy === 'merge' ? 'Restoring…' : 'Merge'}
          </Button>
          <p class="restore-note">
            Recommended. Keeps your library and adds what’s in the backup
            {p.newNovels > 0 ? `, including ${plural(p.newNovels, 'novel')} you don’t have` : ''}.
          </p>
          <Button variant="gray" size="large" destructive onClick={() => void restore('replace')} disabled={busy !== null}>
            {busy === 'replace' ? 'Restoring…' : 'Replace Everything…'}
          </Button>
          <p class="restore-note">Makes the app match the backup exactly.</p>
          <Button variant="plain" size="large" onClick={props.onClose} disabled={busy !== null}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * "Export Library List…": a CSV for a spreadsheet or a plain-text list, written by the script and handed
 * to the share sheet. Not a backup: it can't be restored. Resolves when done (or cancelled).
 */
export async function exportLibraryList(): Promise<void> {
  if (library.value.length === 0) {
    showToast('Your library is empty: nothing to export yet');
    return;
  }
  const i = await actionSheet({
    title: 'Export Library List',
    message: 'Each novel’s name, source, link, chapters read, status, categories and when you last read it.',
    actions: [{ title: 'Spreadsheet (CSV)' }, { title: 'Plain Text' }],
    cancel: 'Cancel',
  });
  if (i < 0) return;
  try {
    // The call returns when the share sheet closes.
    const r = await bridge().call('library.export', { format: i === 0 ? 'csv' : 'text' }, { timeoutMs: 600_000 });
    showToast(`Exported ${plural(r.novels, 'novel')}`);
  } catch (err) {
    const ui = toUiError(err);
    // A timeout means the share sheet may still be open; nothing to report.
    if (ui.code !== 'TIMEOUT') errorToast(`Couldn’t export: ${errorText(ui)}`);
  }
}
