/**
 * Settings › Storage › "Voices & models" (native app): everything TachiNovel keeps on this iPhone beyond the reading
 * data v1's Storage page counts, by category (native: ExpressiveCore StorageMap.swift through DiagFolder.storage):
 * Nephis's packs (the one in use, the others), downloaded voice models, imported voices, chapters made ready for the
 * car, the Voice test recording, web updates, caches, and the leftovers: copies iOS made of a shared .tnmodel
 * (350-500 MB each, kept for ever before 2026-10-13), pack files that didn't install and unfinished unpacks.
 * "Clean Up" removes the leftovers only: never a pack, a model, the reading data or the recording.
 *
 * The row comes from a build-time patch of v1's Storage page (tools/v1-qa.ts) that reads `globalThis.__TN_STORAGE__`
 * (set here, before v1's UI loads).
 */
import { signal, type Signal } from '@preact/signals';
import { formatBytes } from './drive-status.ts';
import { DiagFolder } from './diag-folder.ts';
import { esc, panel, toast } from './voices-ui.ts';

export interface NativeStorageEntry {
  key: string;
  label: string;
  note: string;
  bytes: number;
  count: number;
  leftover: boolean;
}

export interface NativeStorage {
  entries: NativeStorageEntry[];
  /** Everything in the app's container (the entries add up to it). */
  totalBytes: number;
  /** The app itself (it carries the Kokoro voices); not in totalBytes. */
  appBytes: number;
  leftoverBytes: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Native's answer, or null when it isn't one (an older build). */
export function normalizeStorage(raw: unknown): NativeStorage | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { entries?: unknown }).entries)) return null;
  const r = raw as Record<string, unknown> & { entries: unknown[] };
  const entries = r.entries.flatMap((e): NativeStorageEntry[] => {
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const key = str(o.key);
    if (!key) return [];
    return [{ key, label: str(o.label) || key, note: str(o.note), bytes: num(o.bytes), count: num(o.count), leftover: o.leftover === true }];
  });
  const leftoverBytes = entries.filter((e) => e.leftover).reduce((a, e) => a + e.bytes, 0);
  return { entries, totalBytes: Math.max(num(r.totalBytes), entries.reduce((a, e) => a + e.bytes, 0)), appBytes: num(r.appBytes), leftoverBytes };
}

/** The Storage page row's value: "2.4 GB", or "2.4 GB · 410 MB to clean up". */
export function storageRowLabel(s: NativeStorage | null): string {
  if (!s) return '';
  const total = formatBytes(s.totalBytes);
  return s.leftoverBytes >= 1e6 ? `${total} · ${formatBytes(s.leftoverBytes)} to clean up` : total;
}

/** The toast after Clean Up. */
export function cleanedMessage(removed: number, bytes: number): string {
  if (removed <= 0) return 'Nothing to clean up.';
  return `Removed ${removed} leftover${removed === 1 ? '' : 's'}, freed ${formatBytes(bytes)}.`;
}

const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Voices & models', keys: ['packActive', 'packsOther', 'modelPocket', 'modelsOther', 'voices', 'drive', 'recordings'] },
  { title: 'Reading & the app', keys: ['reading', 'documents', 'webUpdates', 'caches', 'other'] },
];

export function openNativeStorage(onChange: () => void = () => undefined): void {
  const p = panel('Voices & models', 'native-storage');
  let data: NativeStorage | null = null;
  let failed = false;
  let busy = false;

  const row = (e: NativeStorageEntry): string =>
    `<div class="row" data-storage="${esc(e.key)}"><div class="main"><b>${esc(e.label)}</b>${e.note ? `<span class="sub">${esc(e.note)}</span>` : ''}</div><span>${esc(formatBytes(e.bytes))}</span></div>`;

  const render = (): void => {
    if (!data) {
      p.body.innerHTML = failed
        ? '<p class="note">Storage isn’t available right now.</p><button type="button" class="btn alt" data-act="retry">Try Again</button>'
        : '<p class="note">Measuring…</p>';
      return;
    }
    const d = data;
    const byKey = new Map(d.entries.map((e) => [e.key, e]));
    const groups = GROUPS.map((g) => {
      const rows = g.keys.flatMap((k) => {
        const e = byKey.get(k);
        return e && (e.bytes > 0 || k === 'packActive') ? [row(e)] : [];
      });
      return rows.length ? `<div class="sec">${esc(g.title)}</div><div class="card">${rows.join('')}</div>` : '';
    }).join('');
    const leftovers = d.entries.filter((e) => e.leftover && e.bytes > 0);
    const clean = leftovers.length
      ? `<div class="sec">Leftovers</div><div class="card" data-testid="native-storage-leftovers">${leftovers.map(row).join('')}</div>
        <button type="button" class="btn" data-act="clean" data-testid="native-storage-clean"${busy ? ' disabled' : ''}>${busy ? 'Cleaning up…' : `Clean Up (${esc(formatBytes(d.leftoverBytes))})`}</button>
        <p class="note">Removes only copies and unfinished unpacks: never a voice pack, a model, your reading data or the recording.</p>`
      : '<p class="note" data-testid="native-storage-clean-none">No leftovers: nothing is stored twice.</p>';
    p.body.innerHTML = `<div class="card"><div class="row" data-testid="native-storage-total"><div class="main"><b>TachiNovel’s data</b><span class="sub">The app itself adds ${esc(formatBytes(d.appBytes))} (it carries the Kokoro voices).</span></div><span>${esc(formatBytes(d.totalBytes))}</span></div></div>
      ${groups}${clean}`;
  };

  const load = (): void => {
    void DiagFolder.storage()
      .then((raw) => {
        data = normalizeStorage(raw);
        failed = !data;
      })
      .catch(() => {
        failed = true;
      })
      .finally(render);
  };

  p.root.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'retry') {
      failed = false;
      render();
      load();
    } else if (el.dataset.act === 'clean' && !busy) {
      busy = true;
      render();
      void DiagFolder.cleanStorage()
        .then((raw) => {
          const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          data = normalizeStorage(r.report) ?? data;
          toast(cleanedMessage(num(r.removed), num(r.bytes)));
          onChange();
        })
        .catch((err: unknown) => toast(`Couldn’t clean up: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          busy = false;
          render();
        });
    }
  });
  render();
  load();
}

interface StorageGlobal {
  /** Row value: total, and what can be cleaned up. */
  label: Signal<string>;
  open(): void;
}

declare global {
  /** Read by v1's Storage page, patched at build time (tools/v1-qa.ts). */
  var __TN_STORAGE__: StorageGlobal | undefined;
}

export function installNativeStorage(): void {
  const label = signal('');
  const refresh = (): void => {
    void DiagFolder.storage()
      .then((raw) => {
        label.value = storageRowLabel(normalizeStorage(raw));
      })
      .catch(() => undefined);
  };
  // Measured when the Storage page shows the row (a walk of the whole container), at most every 30 s; not at launch.
  let last = 0;
  globalThis.__TN_STORAGE__ = {
    get label() {
      if (Date.now() - last > 30_000) {
        last = Date.now();
        refresh();
      }
      return label;
    },
    open: () => openNativeStorage(refresh),
  };
}
