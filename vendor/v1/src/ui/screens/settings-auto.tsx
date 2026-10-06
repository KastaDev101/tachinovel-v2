/**
 * Automatic features shown inside existing settings pages: auto-download of the next unread
 * chapters (Settings › Downloads) and the daily backup (Settings › Backup & Restore).
 */
import { Section, Stepper, SwitchRow } from '../components/controls.tsx';
import { patchSettings, settings } from '../state/store.ts';

export const AHEAD_LIMITS = { min: 1, max: 10 } as const;

export function autoDownloadFooter(ahead: number): string {
  const what = ahead === 1 ? 'the next unread chapter' : `the next ${ahead} unread chapters`;
  return `Keeps ${what} of novels you’re reading saved for offline. Uses storage.`;
}

/** Settings › Downloads: "Auto-download next chapters" + "Chapters ahead" (1–10). */
export function AutoDownloadSection() {
  const a = settings.value.autoDownload;
  return (
    <Section header="Automatic" footer={autoDownloadFooter(a.ahead)}>
      <SwitchRow title="Auto-download next chapters" checked={a.enabled} onChange={(enabled) => patchSettings({ autoDownload: { enabled } })} testId="auto-download" />
      <div class={`row${a.enabled ? '' : ' is-disabled'}`} data-testid="auto-download-ahead">
        <span class="row-main">
          <span class="row-title">Chapters ahead</span>
        </span>
        <Stepper
          label="Chapters ahead"
          value={a.ahead}
          min={AHEAD_LIMITS.min}
          max={AHEAD_LIMITS.max}
          step={1}
          onChange={(ahead) => patchSettings({ autoDownload: { ahead } }, 400)}
        />
      </div>
    </Section>
  );
}

/** Settings › Backup & Restore: "Daily backup". */
export function AutoBackupSection() {
  return (
    <Section footer="Once a day, while TachiNovel is open, a backup is saved to the backups folder. The newest 10 are kept.">
      <SwitchRow title="Daily backup" checked={settings.value.autoBackup} onChange={(autoBackup) => patchSettings({ autoBackup })} testId="auto-backup" />
    </Section>
  );
}
