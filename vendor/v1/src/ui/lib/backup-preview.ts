/**
 * What a backup holds, in words (pure; unit-tested), for the restore preview sheet:
 * "Backup from Oct 5, 9:14 PM" and "12 novels (3 new) · 4 categories · reading progress for
 * 1,240 chapters · 2 sources".
 */
import type { BackupPreview } from '../../shared/contracts/protocol.ts';
import { formatCount, plural } from './format.ts';

export function backupWhen(createdAt: number, now: number): string {
  const sameYear = new Date(createdAt).getFullYear() === new Date(now).getFullYear();
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' });
  return `Backup from ${fmt.format(createdAt)}`;
}

export function backupContents(p: BackupPreview): string {
  const c = p.counts;
  const novels = `${plural(c.novels, 'novel')}${p.newNovels > 0 ? ` (${formatCount(p.newNovels)} new)` : ''}`;
  const progress = c.progress > 0 ? `reading progress for ${plural(c.progress, 'chapter')}` : 'no reading progress';
  return [novels, plural(c.categories, 'category', 'categories'), progress, plural(c.sources, 'source')].join(' · ');
}

/** "2 records can't be read", or null when every record is fine. */
export function backupSkipped(p: BackupPreview): string | null {
  return p.skipped > 0 ? `${plural(p.skipped, 'record')} can’t be read` : null;
}
