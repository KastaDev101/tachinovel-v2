/**
 * "Download with audio" part 2 (2026-10-16), the screens over the engine of build 373 (DrivePrep.swift, the Narration
 * plugin's audio* methods). It replaces "Prepare for the Drive"'s card and sheet (its engine stays):
 *  - Novel page: a "Download with Audio" card under Add to Library / Web View / Share ("Downloading 3 of 12 · Audio
 *    42 %", what is ready, why it waits); it opens the download sheet (audio-sheet.tsx) with Next 5 · Next 10 · Unread.
 *    The chapter selection's Download and a "Download…" item in the novel's ••• menu open it too, and the menu gets
 *    "Remove Downloaded Audio" while the novel has audio (build-time patches of v1's novel page, tools/v1-audio.ts).
 *  - Chapter rows: headphones.circle.fill for text + audio, a small ring for the chapter being made, v1's
 *    arrow.down.circle.fill for text only (the patched row asks `badge`; the list re-renders only when a badge changes).
 *  - More › Downloads: a Queue section (cover, chapter, state, progress ring, ✕; Pause All / Resume All) and a Narration
 *    Audio section (its size → the per-novel list with swipe-to-delete and Edit, Delete Audio After Listening, Include
 *    Audio in Auto-Download, Delete All Audio). More › Storage: a Narration Audio row.
 * Everything reads one live status (audio-live.ts), listened to only while one of these shows.
 * v1 reads `globalThis.__TN_AUDIO__` (set here); without it (a v1 build) v1 behaves as before.
 */
import { effect } from '@preact/signals';
import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';
import { Button, Row, Section, SwitchRow } from '@v1/ui/components/controls.tsx';
import { Cover } from '@v1/ui/components/cover.tsx';
import { Icon } from '@v1/ui/components/icon.tsx';
import { attachSwipe } from '@v1/ui/lib/swipe.ts';
import { getNovelPage } from '@v1/ui/state/novel-cache.ts';
import { settings, symbols } from '@v1/ui/state/store.ts';
import { callCore, observeCalls } from '../capacitor-client.ts';
import { audio, audioLoaded, badges, refreshAudio, setAudio, textProgress, watchAudio } from './audio-live.ts';
import { openDownloadSheet, type DownloadRequest } from './audio-sheet.tsx';
import { audioRow, byNovel, cardLine, chapters, isOpen, jobChapter, jobState, novelKeyOf, playable, storageValue } from './audio-status.ts';
import { formatBytes, formatDuration, jobProgress } from './drive-status.ts';
import { Narration, type DriveJobInfo } from './narration.ts';
import { chevron, confirmStep, esc, icon, panel, toast } from './panel.ts';

const CSS = `
.tn-audio-badge{color:var(--tint)}
.tn-ring{flex:none;color:var(--tint)}
.tn-warn{color:var(--orange)}
.row.tn-stack{flex-direction:column;align-items:stretch;gap:8px}
.tn-q-row{gap:12px}
.tn-q-cover{flex:none;width:40px;border-radius:6px}
.tn-q-x{display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;margin-right:-10px;color:var(--gray-2)}
.tn-audio-card .tn-chev{color:var(--gray-3);display:flex;flex:none}
.tn-v .sw-row .sw-content{background:var(--bg-grouped-2)}
.tn-v .tn-empty{padding:48px 24px 8px;text-align:center}
.tn-v .tn-empty b{display:block;font-size:var(--fs-title3);font-weight:600;margin:10px 0 6px}
.tn-v .tn-empty .icon{color:var(--gray-2)}
`;

let styled = false;
function ensureStyle(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
}

// ------------------------------------------------------------------ pieces

/** A progress ring (0…1), for the chapter being made and the queue rows. */
function Ring(props: { value: number; size?: number; label: string }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, props.value));
  return (
    <svg class="tn-ring chapter-dl" width={props.size ?? 17} height={props.size ?? 17} viewBox="0 0 18 18" role="img" aria-label={props.label}>
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" stroke-opacity="0.22" stroke-width="2.2" />
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-dasharray={`${(c * v).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 9 9)" />
    </svg>
  );
}

interface NovelCtx extends Omit<DownloadRequest, 'selected'> {
  selected?: readonly number[];
}

function openSheet(ctx: NovelCtx): void {
  ensureStyle();
  openDownloadSheet(ctx);
}

/** SF Symbols v1 doesn't load itself (its list is fixed): asked for once, when the audio screens first show. */
const AUDIO_SYMBOL = 'headphones.circle.fill';
let symbolsAsked = false;
function ensureSymbols(): void {
  if (symbolsAsked) return;
  symbolsAsked = true;
  if (AUDIO_SYMBOL in symbols.peek()) return;
  void callCore<Record<string, string>>('native.symbols', { names: [AUDIO_SYMBOL], size: 64 })
    .then((got) => {
      if (Object.keys(got).length > 0) symbols.value = { ...symbols.peek(), ...got };
    })
    .catch(() => undefined);
}

/** A chapter row's badge (v1's patched chapter list). */
function badge(novelKey: string, chapterPath: string, downloaded: boolean): VNode | null {
  const b = badges.value.get(`${novelKey}\u001f${chapterPath}`);
  // headphones.circle.fill from iOS; v1's drawn headphones until it arrives (or where there are no SF Symbols).
  if (b === 'audio') return <Icon name={AUDIO_SYMBOL in symbols.value ? AUDIO_SYMBOL : 'headphones'} size={17} class="chapter-dl tn-audio-badge" />;
  if (typeof b === 'number') return <Ring value={b} label={`Making audio, ${Math.round(b * 100)} percent`} />;
  return downloaded ? <Icon name="arrow.down.circle.fill" size={17} class="chapter-dl" /> : null;
}

async function removeNovelAudio(pluginId: string, novelPath: string, name: string): Promise<void> {
  const yes = await confirmStep('Remove Downloaded Audio?', `The audio of ${name || 'this novel'} is deleted from this iPhone. Its text stays, and Listen reads it live.`, 'Remove');
  if (!yes) return;
  try {
    setAudio(await Narration.audioDelete({ pluginId, novelPath }));
    toast('Downloaded audio removed');
  } catch (err) {
    toast(`Couldn’t remove it: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

// ------------------------------------------------------------------ More › Downloads: the queue

function QueueRow(props: { job: DriveJobInfo }) {
  const j = props.job;
  const text = textProgress.value.get(j.novelKey);
  const pct = Math.round(jobProgress(j) * 100);
  const where = { pluginId: j.pluginId, novelPath: j.novelPath, ...(j.kind ? { kind: j.kind } : {}) };
  const cancel = async (): Promise<void> => {
    // Making a chapter (or paused in one): ask first, the part made goes; a request still waiting goes at once.
    if ((j.state === 'running' || j.state === 'paused') && !(await confirmStep('Stop Making Audio?', `The chapter being made for ${j.novelName || 'this novel'} is thrown away. Chapters already made stay.`, 'Stop'))) return;
    setAudio(await Narration.audioCancel(where).catch(() => audio.value));
  };
  const retry = (): void =>
    void Narration.audioEnqueue({ pluginId: j.pluginId, novelPath: j.novelPath, novelName: j.novelName, chapters: j.chapters ?? [], when: j.when, notify: true })
      .then(setAudio)
      .catch((err: unknown) => toast(`Couldn’t retry: ${err instanceof Error ? err.message : String(err)}`, true));
  return (
    <div class="row tn-q-row" data-testid="audio-queue-row">
      <Cover src={j.coverUrl} pluginId={j.pluginId} title={j.novelName} class="tn-q-cover" />
      <span class="row-main">
        <span class="row-title">{j.novelName || 'Novel'}</span>
        <span class="row-subtitle" data-testid="audio-queue-state">{`${jobChapter(j)} · ${jobState(j, text)}`}</span>
      </span>
      {j.state === 'failed' ? (
        <Button variant="tinted" size="small" onClick={retry}>
          Retry
        </Button>
      ) : (
        <Ring value={pct / 100} size={22} label={`${pct} percent`} />
      )}
      <button type="button" class="tn-q-x tap tap-dim" aria-label={`Cancel ${j.novelName || 'download'}`} onClick={() => void cancel()} data-testid="audio-queue-cancel">
        <Icon name="xmark.circle.fill" size={22} />
      </button>
    </div>
  );
}

function QueueSection() {
  useEffect(() => watchAudio(), []);
  const jobs = audio.value.jobs.filter(isOpen);
  if (!audioLoaded.value || jobs.length === 0) return null;
  const going = jobs.filter((j) => j.state !== 'paused' && j.state !== 'failed');
  const all = async (pause: boolean): Promise<void> => {
    for (const j of pause ? going : jobs.filter((x) => x.state === 'paused')) {
      const where = { pluginId: j.pluginId, novelPath: j.novelPath, ...(j.kind ? { kind: j.kind } : {}) };
      await (pause ? Narration.audioPause(where) : Narration.audioResume(where)).catch(() => undefined);
    }
    await refreshAudio();
  };
  return (
    <Section
      header="Queue"
      headerAction={
        <button type="button" class="link-btn tap tap-dim" onClick={() => void all(going.length > 0)} data-testid="audio-queue-all">
          {going.length > 0 ? 'Pause All' : 'Resume All'}
        </button>
      }
      footer="Text downloads first. Audio is made one chapter at a time; it waits while you listen and when the iPhone gets hot."
    >
      {jobs.map((j) => (
        <QueueRow key={j.key ?? j.novelKey} job={j} />
      ))}
    </Section>
  );
}

// ------------------------------------------------------------------ More › Downloads: Narration Audio

function StorageSection() {
  useEffect(() => watchAudio(), []);
  const s = audio.value;
  const set = (opts: { deleteAfterListening?: boolean; autoDownloadAudio?: boolean }): void =>
    void Narration.audioSetOptions(opts)
      .then(setAudio)
      .catch(() => toast('Couldn’t change the setting', true));
  const deleteAll = async (): Promise<void> => {
    if (!(await confirmStep('Delete All Audio?', `${storageValue(s)} of narration audio is deleted from this iPhone. Downloaded text stays.`, 'Delete All'))) return;
    setAudio(await Narration.audioDelete().catch(() => s));
    toast('All audio deleted');
  };
  return (
    <>
      <Section header="Narration Audio" footer="Audio made with an older voice is never played: Listen reads live and the chapter is made again while charging.">
        <Row title="Narration Audio" value={audioLoaded.value ? storageValue(s) : '…'} chevron onClick={openAudioLibrary} testId="audio-storage" />
        <SwitchRow title="Delete Audio After Listening" checked={s.deleteAfterListening} onChange={(v) => set({ deleteAfterListening: v })} testId="audio-delete-after" />
        <SwitchRow
          title="Include Audio in Auto-Download"
          subtitle="Made only while charging"
          checked={s.autoDownloadAudio === true}
          onChange={(v) => set({ autoDownloadAudio: v })}
          testId="audio-auto"
        />
      </Section>
      {s.audio.length > 0 && (
        <Section>
          <Row title="Delete All Audio" destructive onClick={() => void deleteAll()} testId="audio-delete-all" />
        </Section>
      )}
    </>
  );
}

/** More › Storage: the Narration Audio row (read once when the page opens). */
function StorageRow() {
  useEffect(() => void refreshAudio(), []);
  if (!audioLoaded.value) return null;
  return (
    <Section>
      <Row title="Narration Audio" subtitle="Chapters read by Nephis, kept offline" value={<span class="tabular">{storageValue(audio.value)}</span>} chevron onClick={openAudioLibrary} testId="storage-audio" />
    </Section>
  );
}

// ------------------------------------------------------------------ Narration Audio (per novel, swipe to delete, Edit)

function emptyState(): string {
  return `<div class="tn-empty" data-testid="audio-empty">${icon('headphones', 44)}<b>No Audio Yet</b><p class="note">On a novel’s page, tap Download with Audio. Nephis reads the chapters into audio on this iPhone, to listen offline.</p></div>`;
}

function swipeRow(key: string, body: string, editing: boolean, label: string): string {
  return `<div class="sw-row" data-swipe data-trailing="delete" data-key="${esc(key)}"><div class="sw-actions is-trailing" aria-hidden="true"><button type="button" class="sw-action" tabindex="-1">${icon('trash', 22)}Delete</button></div><div class="sw-content">${body}${editing ? `<button type="button" class="link danger" data-act="del" data-key="${esc(key)}" aria-label="Delete ${esc(label)}">${icon('trash', 20)}</button>` : ''}</div></div>`;
}

/** Narration Audio: every novel with audio; a novel opens its chapters. */
export function openAudioLibrary(): void {
  ensureStyle();
  const p = panel('Narration Audio', 'audio-library');
  const release = watchAudio();
  let editing = false;
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'edit';
  edit.dataset.act = 'edit';
  p.right.append(edit);
  const render = (): void => {
    const s = audio.value;
    const novels = byNovel(s);
    edit.textContent = editing ? 'Done' : 'Edit';
    edit.hidden = novels.length === 0;
    if (!audioLoaded.value) return void (p.body.innerHTML = '<div class="card" aria-busy="true"><div class="row"><span class="skel skel-line" style="width:60%"></span></div></div>');
    if (novels.length === 0) return void (p.body.innerHTML = emptyState());
    const names = new Map(s.audio.map((a) => [a.novelKey, a.novelName ?? '']));
    p.body.innerHTML = `<div class="sec">${chapters(s.audio.length)} · ${formatBytes(s.totalBytes)}</div><div class="card" data-testid="audio-novels">${novels
      .map((n) => {
        const name = names.get(n.novelKey) || n.name;
        return swipeRow(
          n.novelKey,
          `<button type="button" class="row" data-act="open" data-key="${esc(n.novelKey)}"><span class="main"><b>${esc(name)}</b><span class="sub">${chapters(n.count)} · ${formatDuration(n.seconds)}</span></span><span class="val">${formatBytes(n.bytes)}</span>${editing ? '' : chevron()}</button>`,
          editing,
          name,
        );
      })
      .join('')}</div><p class="note">Swipe left on a novel to delete its audio. Its downloaded text stays.</p>`;
  };
  const del = (key: string): void => {
    const name = byNovel(audio.value).find((n) => n.novelKey === key)?.name ?? '';
    const i = key.indexOf(':');
    void removeNovelAudio(key.slice(0, i), key.slice(i + 1), audio.value.audio.find((a) => a.novelKey === key)?.novelName || name);
  };
  const offSwipe = attachSwipe(p.body, { onCommit: (row) => del(row.dataset.key ?? '') });
  const stop = effect(() => {
    void audio.value;
    void audioLoaded.value;
    render();
  });
  p.root.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    switch (el.dataset.act ?? '') {
      case 'edit':
        editing = !editing;
        render();
        return;
      case 'del':
        del(el.dataset.key ?? '');
        return;
      case 'open':
        if (!editing) openNovelAudio(el.dataset.key ?? '');
        return;
      default:
    }
  });
  p.onClose(() => {
    stop();
    offSwipe();
    release();
  });
}

/** One novel's chapters with audio (swipe to delete one, Edit, Remove Downloaded Audio). */
function openNovelAudio(novelKey: string): void {
  const first = audio.value.audio.find((a) => a.novelKey === novelKey);
  const name = first?.novelName || byNovel(audio.value).find((n) => n.novelKey === novelKey)?.name || 'Novel';
  const p = panel(name, 'audio-novel');
  const release = watchAudio();
  const i = novelKey.indexOf(':');
  const where = { pluginId: novelKey.slice(0, i), novelPath: novelKey.slice(i + 1) };
  let editing = false;
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'edit';
  edit.dataset.act = 'edit';
  p.right.append(edit);
  const render = (): void => {
    const list = audio.value.audio.filter((a) => a.novelKey === novelKey);
    edit.textContent = editing ? 'Done' : 'Edit';
    edit.hidden = list.length === 0;
    if (list.length === 0) return void (p.body.innerHTML = emptyState());
    p.body.innerHTML = `<div class="sec">${chapters(list.length)} · ${formatBytes(list.reduce((a, c) => a + c.bytes, 0))}</div><div class="card" data-testid="audio-chapters">${list
      .map((a) =>
        swipeRow(a.chapterPath, `<div class="row"><span class="main"><b>${esc(a.title)}</b><span class="sub">${esc(audioRow(a))}</span></span>${playable(a) ? '' : icon('arrow.triangle.2.circlepath', 18, 'warn')}</div>`, editing, a.title),
      )
      .join('')}</div><button type="button" class="btn alt danger" data-act="all">Remove Downloaded Audio</button>`;
  };
  const delChapter = (path: string): void =>
    void Narration.audioDelete({ ...where, chapterPaths: [path] })
      .then((s) => {
        setAudio(s);
        toast('Audio deleted');
      })
      .catch(() => toast('Couldn’t delete it', true));
  const offSwipe = attachSwipe(p.body, { onCommit: (row) => delChapter(row.dataset.key ?? '') });
  const stop = effect(() => {
    void audio.value;
    render();
  });
  p.root.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    switch (el.dataset.act ?? '') {
      case 'edit':
        editing = !editing;
        render();
        return;
      case 'del':
        delChapter(el.dataset.key ?? '');
        return;
      case 'all':
        void removeNovelAudio(where.pluginId, where.novelPath, name);
        return;
      default:
    }
  });
  p.onClose(() => {
    stop();
    offSwipe();
    release();
  });
}

// ------------------------------------------------------------------ the novel page card

let lastNovel: { pluginId: string; novelPath: string } | null = null;
let cardRelease: (() => void) | null = null;

function novelCtx(pluginId: string, novelPath: string, fallbackName: string): NovelCtx | null {
  const page = getNovelPage(novelKeyOf(pluginId, novelPath));
  if (!page) return null;
  return {
    pluginId,
    novelPath,
    name: page.details.name || fallbackName,
    cover: page.details.cover,
    chapters: page.chapters,
    lastRead: page.lastRead,
    markReadAt: settings.peek().reader.markReadAt,
  };
}

function paintCard(card: HTMLElement): void {
  const text = cardLine(audio.value, `${card.dataset.plugin ?? ''}:${card.dataset.path ?? ''}`);
  const line = card.querySelector('[data-audio-line]');
  if (line && line.textContent !== text) line.textContent = text;
  card.querySelector('button')?.setAttribute('aria-label', `Download with Audio: ${text}`);
}

function paintCards(): void {
  for (const card of document.querySelectorAll<HTMLElement>('[data-testid="audio-card"]')) paintCard(card);
}

/** Novel page: the card (re-applied after v1 renders, v1-hooks.ts); the live status is listened to while one shows. */
export function addAudioCard(): void {
  const screens = [...document.querySelectorAll<HTMLElement>('[data-testid="screen-novel"]')];
  for (const [i, screen] of screens.entries()) {
    if (screen.querySelector('[data-testid="audio-card"]')) continue;
    const ref = lastNovel;
    const actions = screen.querySelector('[data-testid="open-safari"]')?.parentElement;
    // Only the newest novel screen matches the last novel.get call.
    if (!ref || i !== screens.length - 1 || !actions) continue;
    ensureStyle();
    const card = document.createElement('div');
    card.className = 'nar-card tn-audio-card';
    card.dataset.testid = 'audio-card';
    card.dataset.plugin = ref.pluginId;
    card.dataset.path = ref.novelPath;
    card.innerHTML = `<button type="button" class="nar-card-main tap tap-dim"><span class="nar-card-icon" aria-hidden="true">${icon('arrow.down.circle', 22)}</span><span class="nar-card-text"><span class="nar-card-title">Download with Audio</span><span class="nar-card-line" data-audio-line></span></span></button><span class="tn-chev" aria-hidden="true">${icon('chevron.right', 14)}</span>`;
    card.querySelector('button')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const name = screen.querySelector('[data-testid="novel-title"]')?.textContent.trim() ?? '';
      const ctx = novelCtx(ref.pluginId, ref.novelPath, name);
      if (!ctx || ctx.chapters.length === 0) return toast('The chapter list is still loading');
      openSheet(ctx);
    });
    actions.after(card);
    paintCard(card);
  }
  const shown = document.querySelector('[data-testid="audio-card"]') !== null;
  if (shown && !cardRelease) {
    ensureSymbols();
    cardRelease = watchAudio();
  }
  else if (!shown && cardRelease) {
    cardRelease();
    cardRelease = null;
  }
}

// ------------------------------------------------------------------ v1's hook

interface AudioGlobal {
  badge(novelKey: string, chapterPath: string, downloaded: boolean): VNode | null;
  download(ctx: NovelCtx): void;
  menu(novelKey: string): { title: string; destructive?: boolean }[];
  onMenu(choice: string, ctx: NovelCtx): void;
  queue(): VNode;
  storage(): VNode;
  storageRow(): VNode;
}

declare global {
  /** Read by v1's novel page and Downloads / Storage pages, patched at build time (tools/v1-audio.ts). */
  var __TN_AUDIO__: AudioGlobal | undefined;
}

const DOWNLOAD = 'Download…';
const REMOVE = 'Remove Downloaded Audio';

export function installAudioDownloads(): void {
  globalThis.__TN_AUDIO__ = {
    badge,
    download: openSheet,
    menu: (key) => [{ title: DOWNLOAD }, ...(audio.value.audio.some((a) => a.novelKey === key) ? [{ title: REMOVE, destructive: true }] : [])],
    onMenu: (choice, ctx) => {
      if (choice === DOWNLOAD) openSheet(ctx);
      else if (choice === REMOVE) void removeNovelAudio(ctx.pluginId, ctx.novelPath, ctx.name);
    },
    queue: () => <QueueSection />,
    storage: () => <StorageSection />,
    storageRow: () => <StorageRow />,
  };
  observeCalls((method, args) => {
    if (method !== 'novel.get' || !args || typeof args !== 'object') return;
    const a = args as { pluginId?: unknown; path?: unknown };
    if (typeof a.pluginId === 'string' && typeof a.path === 'string') lastNovel = { pluginId: a.pluginId, novelPath: a.path };
  });
  // The cards follow the live status (a no-op while no card shows).
  effect(() => {
    void audio.value;
    paintCards();
  });
}
