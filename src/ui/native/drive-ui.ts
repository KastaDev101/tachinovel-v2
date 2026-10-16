/**
 * "Prepare for the drive" (v2 addition over the unchanged v1 UI; native side: DrivePrep.swift):
 *
 *  - Novel page: a "Prepare for the drive" card where v1's PC-narrator "Listen in the car" card was (stubbed out at
 *    build time, tools/v1.ts). Its line says what is ready, what is being prepared and why it waits.
 *  - The sheet: how many chapters (1/3/5/10, from where listening would resume), now or while charging /
 *    on Wi-Fi, live progress, what is on the iPhone and how much space it takes, Remove.
 * Prepared chapters play first (no synthesis, no network), keep sentence highlighting, and are deleted
 * after they are listened to.
 */
import { callCore, observeCalls } from '../capacitor-client.ts';
import { DRIVE_CHAPTER_CHOICES, driveLine, formatBytes, formatDuration, jobProgress, normalizeDriveStatus } from './drive-status.ts';
import { Narration, type DriveStatus } from './narration.ts';
import { confirmStep, esc, icon, panel, segmented, toast } from './panel.ts';

const COUNT_KEY = 'tn.drive.chapters';

const CSS = `
.tn-drive-card .tn-drive-chev{color:var(--gray-3);display:flex;flex:none}
`;

const ICON_CAR =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 17h14v-5l-2-5H7l-2 5z"/><path d="M5 12h14"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/></svg>';

interface NovelRef {
  pluginId: string;
  novelPath: string;
}

let latest: DriveStatus = normalizeDriveStatus(null);
let lastNovel: NovelRef | null = null;
const renderers = new Set<() => void>();

function rerender(): void {
  for (const r of renderers) r();
  for (const card of document.querySelectorAll<HTMLElement>('[data-testid="drive-card"]')) paintCard(card);
}

async function refresh(): Promise<void> {
  latest = normalizeDriveStatus(await Narration.driveStatus().catch(() => null));
  rerender();
}

let styled = false;
function ensureStyle(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
}

function paintCard(card: HTMLElement): void {
  const key = `${card.dataset.plugin ?? ''}:${card.dataset.path ?? ''}`;
  const line = card.querySelector('[data-drive-line]');
  const text = driveLine(latest, key);
  if (line && line.textContent !== text) line.textContent = text;
  card.querySelector('button')?.setAttribute('aria-label', `Prepare for the Drive: ${text}`);
}

/** Novel page: the drive card (re-applied by v1-hooks after every v1 render). */
export function addDriveCard(): void {
  const screens = [...document.querySelectorAll<HTMLElement>('[data-testid="screen-novel"]')];
  for (const [i, screen] of screens.entries()) {
    if (screen.querySelector('[data-testid="drive-card"]')) continue;
    // Only the newest novel screen matches the last novel.get call.
    const ref = lastNovel;
    const actions = screen.querySelector('[data-testid="open-safari"]')?.parentElement;
    if (!ref || i !== screens.length - 1 || !actions) continue;
    ensureStyle();
    const card = document.createElement('div');
    card.className = 'nar-card tn-drive-card';
    card.dataset.testid = 'drive-card';
    card.dataset.plugin = ref.pluginId;
    card.dataset.path = ref.novelPath;
    card.innerHTML = `<button type="button" class="nar-card-main tap tap-dim"><span class="nar-card-icon" aria-hidden="true">${ICON_CAR}</span><span class="nar-card-text"><span class="nar-card-title">Prepare for the Drive</span><span class="nar-card-line" data-drive-line></span></span></button><span class="tn-drive-chev" aria-hidden="true">${icon('chevron.right', 14)}</span>`;
    card.querySelector('button')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const name = screen.querySelector('[data-testid="novel-title"]')?.textContent.trim() ?? '';
      openDriveSheet({ ...ref, name });
    });
    actions.after(card);
    paintCard(card);
  }
}

/** Listeners: which novel the novel page shows (its novel.get call), and live drive progress. */
export function installDrive(): void {
  observeCalls((method, args) => {
    if (method !== 'novel.get' || !args || typeof args !== 'object') return;
    const a = args as { pluginId?: unknown; path?: unknown };
    if (typeof a.pluginId === 'string' && typeof a.path === 'string') lastNovel = { pluginId: a.pluginId, novelPath: a.path };
  });
  void Narration.addListener('drive', (s) => {
    latest = normalizeDriveStatus(s);
    rerender();
  }).catch(() => undefined);
  void refresh();
}

function savedCount(): number {
  try {
    const n = Number(localStorage.getItem(COUNT_KEY));
    return (DRIVE_CHAPTER_CHOICES as readonly number[]).includes(n) ? n : 3;
  } catch {
    return 3;
  }
}

function saveCount(n: number): void {
  try {
    localStorage.setItem(COUNT_KEY, String(n));
  } catch {
    // private mode: keep the default next time
  }
}

/** The sheet for one novel. */
export function openDriveSheet(novel: NovelRef & { name: string }): void {
  ensureStyle();
  const p = panel('Prepare for the Drive', 'drive-sheet');
  const key = `${novel.pluginId}:${novel.novelPath}`;
  let count = savedCount();
  let startName = '';

  const render = (): void => {
    if (!p.root.isConnected) return void renderers.delete(render);
    const job = latest.jobs.find((j) => j.novelKey === key);
    const ready = latest.prepared.filter((c) => c.novelKey === key);
    const bytes = ready.reduce((a, c) => a + c.bytes, 0);
    const busy = job && (job.state === 'running' || job.state === 'waiting' || job.state === 'queued');
    const pct = job ? Math.round(jobProgress(job) * 100) : 0;
    const jobHtml = job
      ? `<div class="sec">Progress</div><div class="card"><div class="row"><span class="main">
          <b>${esc(job.state === 'done' ? `${job.done} of ${job.count} chapters prepared` : job.state === 'failed' ? 'Stopped' : `Preparing ${job.count} chapter${job.count === 1 ? '' : 's'}`)}</b>
          <span class="sub" data-drive-status>${esc(driveLine(latest, key))}${job.current && job.state === 'running' ? ` · ${esc(job.current.title)}` : ''}</span>
          ${busy ? `<span class="prog" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></span>` : ''}
        </span></div>${busy ? '<button type="button" class="row" data-act="cancel"><span class="main"><b class="danger">Stop Preparing</b></span></button>' : ''}</div>`
      : '';
    const readyRows = ready
      .map((c) => `<div class="row"><span class="main"><b>${esc(c.title)}</b></span><span class="val">${formatDuration(c.durationSec)} · ${formatBytes(c.bytes)}</span></div>`)
      .join('');
    p.body.innerHTML = `
      <div class="sec">Chapters</div>
      <div class="card"><div class="row seg-row">${segmented(
        'count',
        'How many chapters',
        DRIVE_CHAPTER_CHOICES.map((n) => [String(n), String(n)] as const),
        String(count),
      )}</div></div>
      <p class="note" data-start>${startName ? `Starting where you’d continue: ${esc(startName)}.` : 'Starting where you’d continue listening.'}</p>
      <button type="button" class="btn" data-act="now">Prepare Now</button>
      <button type="button" class="btn alt" data-act="later">When Charging or on Wi-Fi</button>
      <p class="note">Nephis reads the chapters into audio on this iPhone, so listening in the car never waits for the voice or the internet. Each one is deleted after you listen to it.</p>
      ${jobHtml}
      <div class="sec">On This iPhone</div>
      ${
        ready.length > 0
          ? `<div class="card">${readyRows}</div><p class="note">${ready.length} chapter${ready.length === 1 ? '' : 's'} · ${formatBytes(bytes)}. All prepared audio: ${formatBytes(latest.totalBytes)}.</p><button type="button" class="btn alt danger" data-act="clear">Remove Prepared Audio</button>`
          : '<div class="card"><div class="row"><span class="main sub">Nothing prepared for this novel yet.</span></div></div>'
      }`;
  };

  const start = async (when: 'now' | 'chargingOrWifi'): Promise<void> => {
    saveCount(count);
    try {
      latest = normalizeDriveStatus(await Narration.prepareDrive({ pluginId: novel.pluginId, novelPath: novel.novelPath, novelName: novel.name, chapters: count, when }));
      toast(when === 'now' ? `Preparing ${count} chapter${count === 1 ? '' : 's'}…` : 'Will prepare while charging or on Wi-Fi');
    } catch (err) {
      toast(`Couldn’t start: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    rerender();
  };

  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    switch (el?.dataset.act ?? '') {
      case 'count':
        count = Number(el?.dataset.v) || 3;
        render();
        return;
      case 'now':
        void start('now');
        return;
      case 'later':
        void start('chargingOrWifi');
        return;
      case 'cancel':
        void Narration.cancelDrive({ pluginId: novel.pluginId, novelPath: novel.novelPath }).then(refresh, () => undefined);
        return;
      case 'clear':
        void confirmStep('Remove Prepared Audio?', `The prepared chapters of ${novel.name || 'this novel'} are deleted. Listen reads them live instead.`, 'Remove').then((yes) => {
          if (!yes) return;
          void Narration.clearDrive({ pluginId: novel.pluginId, novelPath: novel.novelPath })
            .then((s) => {
              latest = normalizeDriveStatus(s);
              rerender();
              toast('Prepared audio removed');
            })
            .catch((err: unknown) => toast(`Couldn’t remove it: ${err instanceof Error ? err.message : String(err)}`, true));
        });
        return;
      default:
    }
  });
  renderers.add(render);
  render();
  void refresh();
  void callCore<{ chapterName?: string; chapterPath: string } | null>('narration.resumePoint', { pluginId: novel.pluginId, novelPath: novel.novelPath })
    .then((r) => {
      startName = r?.chapterName ?? '';
      render();
    })
    .catch(() => undefined);
}
