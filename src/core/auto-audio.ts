/**
 * Settings › Downloads › "Include Audio in Auto-Download" (2026-10-16): the chapters v1's smart downloads queue get
 * audio too. v1's AutoDownloadService is unchanged; this wraps its `run` and the download queue's `enqueue` on the live
 * service objects, so every chapter list enqueued while an auto-download run is going is reported to native as one
 * "v2.autoDownloaded" event ({pluginId, novelPath, chapterPaths, novelName?, cover?}). Native (DrivePrep.register)
 * queues their audio, made only while charging, when the setting is on; otherwise it ignores the event.
 *
 * A chapter the user downloads by hand in the moment an auto run awaits the network would be reported too: harmless
 * (its audio is then made while charging, only with the setting on).
 */
import type { App } from '@v1/script/app.ts';

export const AUTO_DOWNLOADED_EVENT = 'v2.autoDownloaded';

export interface AutoDownloaded {
  pluginId: string;
  novelPath: string;
  chapterPaths: string[];
  novelName?: string;
  cover?: string;
}

export function reportAutoDownloads(app: Pick<App, 'services'>, emit: (event: string, payload: AutoDownloaded) => void): void {
  const { downloads, autoDownload, history } = app.services;
  let running = 0;
  const run = autoDownload.run.bind(autoDownload);
  autoDownload.run = (keys) => {
    running++;
    const p = run(keys);
    void p.finally(() => running--);
    return p;
  };
  const enqueue = downloads.enqueue.bind(downloads);
  downloads.enqueue = (novel, chapterPaths) => {
    enqueue(novel, chapterPaths);
    if (running === 0 || chapterPaths.length === 0) return;
    const h = history.all().find((e) => e.pluginId === novel.pluginId && e.path === novel.path);
    emit(AUTO_DOWNLOADED_EVENT, {
      pluginId: novel.pluginId,
      novelPath: novel.path,
      chapterPaths: [...chapterPaths],
      ...(h?.novelName ? { novelName: h.novelName } : {}),
      ...(h?.cover ? { cover: h.cover } : {}),
    });
  };
}
