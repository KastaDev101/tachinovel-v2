/**
 * The audio downloads' live state for the screens (the novel card and chapter badges, the download sheet, the queue,
 * Narration Audio): one Narration "audio" listener, registered only while one of them shows (watch/unwatch, counted).
 * Native sends the event only when something changes (a request, progress while a chapter is made, the store), so an
 * idle queue costs nothing and no screen polls. Opening a screen reads the status once.
 * Also: the text download's progress per novel (v1's `downloads.progress` events), for the queue's "Text 3 of 12", and
 * a toast when a download finishes while a screen shows (iOS shows no notification for an app in front).
 */
import { batch, signal } from '@preact/signals';
import type { PluginListenerHandle } from '@capacitor/core';
import { sharedClient } from '../capacitor-client.ts';
import { badgeSignature, buildBadges, chapters, finishedDownloads, normalizeAudioStatus, type Badge } from './audio-status.ts';
import { Narration, type AudioStatus } from './narration.ts';
import { toast } from './panel.ts';

export const audio = signal<AudioStatus>(normalizeAudioStatus(null));
/** Set once the first status arrived (screens show skeletons until then). */
export const audioLoaded = signal(false);
/** novelKey + "\u001f" + chapterPath → badge; replaced only when a badge changes (the chapter list re-renders then). */
export const badges = signal<Map<string, Badge>>(new Map());
/** Text downloads in progress (v1's queue), per novel key. */
export const textProgress = signal<Map<string, { done: number; total: number; finished: boolean }>>(new Map());

let watchers = 0;
let handle: Promise<PluginListenerHandle> | null = null;
let signature = '';
let textOff: (() => void) | null = null;

export function setAudio(raw: unknown): void {
  const next = normalizeAudioStatus(raw);
  const done = audioLoaded.value ? finishedDownloads(audio.value, next) : [];
  const b = buildBadges(next);
  const sig = badgeSignature(b);
  batch(() => {
    audio.value = next;
    audioLoaded.value = true;
    if (sig !== signature) {
      signature = sig;
      badges.value = b;
    }
  });
  for (const j of done) toast(`${chapters(j.done)} of ${j.novelName || 'the novel'} ${j.done === 1 ? 'is' : 'are'} ready to listen offline`);
}

/** Read the status once (a screen opened, or after an action whose answer isn't the full status). */
export function refreshAudio(): Promise<void> {
  return Narration.audioStatus()
    .then(setAudio)
    .catch(() => {
      audioLoaded.value = true;
    });
}

/** Keep the state live while a screen shows it; returns the release. */
export function watchAudio(): () => void {
  watchers++;
  if (watchers === 1) {
    handle = Narration.addListener('audio', setAudio);
    handle.catch(() => undefined);
    textOff = sharedClient().on('downloads.progress', (p) => {
      const m = new Map(textProgress.value);
      m.set(`${p.pluginId}:${p.novelPath}`, { done: p.done, total: p.total, finished: p.finished });
      textProgress.value = m;
    });
    void refreshAudio();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchers--;
    if (watchers > 0) return;
    const h = handle;
    handle = null;
    void h?.then((x) => x.remove()).catch(() => undefined);
    textOff?.();
    textOff = null;
  };
}

/** Screens use this to know whether anything listens (tests). */
export function audioWatchers(): number {
  return watchers;
}
