/**
 * Plain-text diagnostics report (pure; unit-tested). Only what helps debugging: versions, device,
 * storage, sources and a settings summary. No search history, rule patterns or novel names.
 */
import type { AppSettings, DeviceInfo, SourceInfo, StorageCategory, StorageUsage } from '../../shared/contracts/domain.ts';
import { formatBytes, plural } from './format.ts';

export interface DiagnosticsInput {
  now: number;
  /** BootPayload.buildVersion (script build). */
  build: string;
  ui: { version: string; hash: string; time: string };
  device: DeviceInfo | null;
  storage: StorageUsage | null;
  sources: readonly SourceInfo[];
  library: { novels: number; categories: number };
  settings: AppSettings;
  /** Recent warn/error lines from app.logs (newest first), or null if they couldn't be read. */
  logs: readonly LogLine[] | null;
}

export interface LogLine {
  at: number;
  level: string;
  message: string;
}

/** How many log lines Diagnostics asks for and shows. */
export const RECENT_PROBLEMS = 20;

export const STORAGE_LABELS: Record<StorageCategory, string> = {
  downloads: 'downloads',
  cache: 'read-ahead cache',
  covers: 'covers',
  meta: 'chapter lists',
  state: 'library & settings',
  logs: 'logs',
};

export function deviceLine(d: DeviceInfo): string {
  return `${d.model}, iOS ${d.systemVersion}, battery ${Math.round(d.batteryLevel * 100)}%${d.charging ? ' (charging)' : ''}, ${d.dark ? 'dark' : 'light'} mode, brightness ${Math.round(d.brightness * 100)}%`;
}

export function storageTotal(s: StorageUsage): number {
  return Object.values(s.bytes).reduce((a, b) => a + b, 0);
}

export function sourceLine(s: SourceInfo): string {
  const tags = [s.builtIn ? 'built in' : '', s.enabled ? 'enabled' : 'disabled', s.updateAvailable ? `update ${s.updateAvailable}` : '', s.lang].filter(Boolean);
  return `${s.name} (${s.id}) ${s.version} · ${tags.join(' · ')}`;
}

export function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function diagnosticsText(d: DiagnosticsInput): string {
  const s = d.settings;
  const lines = [
    `TachiNovel diagnostics · ${stamp(d.now)}`,
    `App: ${d.build || 'unknown'} (UI ${d.ui.version}, ${d.ui.hash}, built ${d.ui.time})`,
    `Device: ${d.device ? deviceLine(d.device) : 'unavailable'}`,
  ];
  if (d.storage) {
    const parts = (Object.keys(STORAGE_LABELS) as StorageCategory[]).map((k) => `${STORAGE_LABELS[k]} ${formatBytes(d.storage?.bytes[k] ?? 0)}`);
    lines.push(
      `Storage: ${formatBytes(storageTotal(d.storage))} · ${parts.join(', ')} (caps: cache ${formatBytes(d.storage.caps.cacheBytes)}, covers ${formatBytes(d.storage.caps.coverBytes)})`,
    );
  } else lines.push('Storage: unavailable');
  lines.push(`Library: ${plural(d.library.novels, 'novel')}, ${plural(d.library.categories, 'category', 'categories')}`);
  lines.push(
    `Settings: appearance ${s.appearance}, read-ahead ${s.readAhead}, languages ${s.languages.join(' + ') || 'none'}, incognito ${s.incognito ? 'on' : 'off'}, ` +
      `auto-download ${s.autoDownload.enabled ? `on (${s.autoDownload.ahead} ahead)` : 'off'}, daily backup ${s.autoBackup ? 'on' : 'off'}, ` +
      `${plural(s.cleanupRules.filter((r) => r.enabled).length, 'cleanup rule')} on, reader ${s.reader.theme}/${s.reader.font} ${s.reader.fontSize}px`,
  );
  lines.push(`Sources (${d.sources.length}):`);
  for (const src of [...d.sources].sort((a, b) => a.name.localeCompare(b.name))) lines.push(`- ${sourceLine(src)}`);
  if (d.logs === null) lines.push('Recent problems: unavailable');
  else if (d.logs.length === 0) lines.push('Recent problems: none');
  else {
    lines.push(`Recent problems (${d.logs.length}):`);
    for (const l of d.logs) lines.push(`- ${stamp(l.at)} ${l.level}: ${l.message.replace(/\s+/g, ' ').trim()}`);
  }
  return lines.join('\n');
}
