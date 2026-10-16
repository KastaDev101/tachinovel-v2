/**
 * "Pronounce" in the reader (Kasta, 2026-10-14: the narrator says made-up names wrong: Nephis, Seishan, Sunny, Cassie).
 *
 * Select a name in a chapter (long-press, as for a quote): v1's quote bar (Copy quote / Share quote) gets a third
 * button, "Pronounce", while the selection is a word or a short name (user-pronunciations.ts pronounceTarget;
 * "Nephis’s" → "Nephis"). It opens the pronunciation panel: type how it should sound ("NEF-iss", "say-SHAHN":
 * hyphens between syllables, the stressed one in capitals, or any plain spelling), ▶ hear it with the voice that
 * reads this novel (Nephis when she reads, else the novel's Kokoro voice) through the real narration pipeline,
 * "All novels" to use it everywhere, Save, Remove, and the novel's whole list (the pronunciation editor in
 * voices-ui.ts, also at Listen player › Voice › Pronunciations; the global list is at Settings › Voices).
 *
 * Storage is the existing pronunciation store (core narration.lexicon.get/set); narration applies the entries for
 * every engine (speech-script.ts → user-pronunciations.ts withUserPronunciations). The page text never changes.
 *
 * Vanilla DOM over the unchanged v1 reader (like narration-overlay.ts' Listen tool); re-added when v1 re-renders.
 */
import { htmlToBlocks, type Lexicon } from '@v1tts/frontend.ts';
import { speechScript } from '../../core/narration/speech-script.ts';
import {
  findEntry,
  parseRespelling,
  plainRespelling,
  pronounceTarget,
  removePronunciation,
  respellingProblem,
  savePronunciation,
  type FoundEntry,
} from '../../core/narration/user-pronunciations.ts';
import { callCore, observeCalls } from '../capacitor-client.ts';
import { ExpressiveVoice } from './expressive-lab.ts';
import { Narration } from './narration.ts';
import { chevron, confirmStep, esc, icon, panel, skeleton, switchInput, toast, unavailable } from './panel.ts';
import { normalizeVoiceSettings, openLexiconEditor } from './voices-ui.ts';

export interface NovelRef {
  pluginId: string;
  novelPath: string;
}

interface Lists {
  global: Lexicon;
  novel: Lexicon | null;
}

const EMPTY: Lexicon = { schemaVersion: 1, entries: [] };

const STYLE = `
.rd-quote-bar:has(.tn-pronounce) .rd-quote-btn{padding:0 9px}
.rd-quote-bar .tn-pronounce[hidden]{display:none}
.tn-v .tn-pr-hint{color:var(--label-2);font-size:var(--fs-footnote);margin:0 2px;min-height:1.3em}
`;

/** "<pluginId>:<novelPath>", the pronunciation store's novel key (core.ts novelKeyString). */
export function novelKeyOf(n: NovelRef): string {
  return `${n.pluginId}:${n.novelPath}`;
}

/** The line under the field: how the voices will read what's typed. */
export function respellingHint(say: string, word: string): string {
  const s = say.trim();
  if (!s) return '';
  const r = parseRespelling(s);
  if (!r) return `Read as “${s}”.`;
  const stressed = r
    .flat()
    .filter((x) => x.stress === 1)
    .map((x) => x.letters.toUpperCase());
  return `Read as “${plainRespelling(r, /^\p{Lu}/u.test(word))}”${stressed.length ? `, stress on ${stressed.join(', ')}` : ''}.`;
}

/** The sentence ▶ plays, as narration would read it (the real script, with this one entry). */
export function previewLine(word: string, say: string): { text: string; raw: string; runs?: { t?: string; p?: string }[] } | null {
  const html = `<p>${esc(word)}. I said, ${esc(word)}.</p>`;
  const it = speechScript(htmlToBlocks(html), { lexicons: [{ schemaVersion: 1, entries: [{ match: word, say }] }] }).items[0];
  if (!it) return null;
  return { text: it.text, raw: it.delivery?.raw ?? it.text, ...(it.runs ? { runs: it.runs } : {}) };
}

async function loadLists(novelKey: string): Promise<Lists> {
  const r = await callCore<{ global?: Lexicon; novel?: Lexicon | null }>('narration.lexicon.get', { novelKey });
  return { global: r.global ?? EMPTY, novel: r.novel ?? null };
}

async function writeLists(novelKey: string, changed: { global?: Lexicon; novel?: Lexicon }): Promise<void> {
  if (changed.global) await callCore('narration.lexicon.set', { lexicon: changed.global });
  if (changed.novel) await callCore('narration.lexicon.set', { novelKey, lexicon: changed.novel });
}

/** ▶: Nephis when she reads chapters, else this novel's Kokoro voice (the Apple voice stands in when Kokoro can't). */
async function hear(novel: NovelRef, word: string, say: string): Promise<void> {
  const line = previewLine(word, say);
  if (!line) return;
  const info = normalizeVoiceSettings(await Narration.voiceSettings(novel).catch(() => null));
  const nephis = info?.delivery?.listenEngine === 'pocket-tts' && info.delivery.pocketVoice === 'nephis' && !info.delivery.nephisOff;
  if (nephis) {
    try {
      await ExpressiveVoice.play({ engine: 'pocket-tts', sample: 'custom', lines: [{ text: line.raw, emotion: 'neutral', role: 'narrator' }] });
      return;
    } catch {
      // Her model isn't there or can't play now: her backup voice says it instead.
    }
  }
  await Narration.sampleVoice({ voice: info?.effectiveVoice ?? info?.defaultVoice ?? 'af_heart', text: line.text, ...(line.runs ? { runs: line.runs } : {}) });
}

/** The pronunciation panel for one word of one novel. */
export function openPronounceSheet(opts: { word: string; novel: NovelRef; novelName: string }): void {
  const { word, novel } = opts;
  const novelKey = novelKeyOf(novel);
  const label = opts.novelName.trim() || 'this novel';
  const p = panel('Pronunciation', 'pronounce-sheet');
  let lists: Lists | null = null;
  let found: FoundEntry | null = null;
  let failed = false;
  let busy = false;
  let playing = false;

  /** Close the panel; a preview Nephis is still reading stops with it (the panel stops Kokoro samples itself). */
  const done = (): void => {
    if (playing) void ExpressiveVoice.stop().catch(() => undefined);
    p.close();
  };
  p.root.addEventListener('click', (ev) => {
    if (playing && (ev.target as Element).closest('[data-act="close"]')) void ExpressiveVoice.stop().catch(() => undefined);
  });

  const render = (): void => {
    if (!lists) {
      p.body.innerHTML = failed ? unavailable('Pronunciations aren’t available right now.') : skeleton(2);
      return;
    }
    const say = found?.entry.say ?? '';
    const all = found?.scope === 'global';
    p.body.innerHTML = `
      <div class="sec">How to say “${esc(word)}”</div>
      <div class="card"><div class="form">
        <input type="text" data-f="say" value="${esc(say)}" placeholder="e.g. NEF-iss" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" aria-label="How ${esc(word)} should sound" data-testid="pronounce-say">
        <p class="tn-pr-hint" data-hint aria-live="polite">${esc(respellingHint(say, word))}</p>
      </div></div>
      <p class="note">Hyphens between syllables, the stressed one in capitals: NEF-iss, say-SHAHN, KASS-ee. Any spelling that sounds right works too.</p>
      <button type="button" class="btn alt" data-act="hear" data-testid="pronounce-hear">${icon('play.fill', 16)}Hear It</button>
      <div class="sec">Where</div>
      <div class="card"><label class="row"><span class="main"><b>All Novels</b></span>${switchInput('data-f="all" data-testid="pronounce-all"', all, 'Use in all novels')}</label></div>
      <p class="note">Off: only in ${esc(label)}.</p>
      <button type="button" class="btn" data-act="save" data-testid="pronounce-save">Save</button>
      ${found ? `<button type="button" class="btn alt danger" data-act="remove" data-testid="pronounce-remove">Remove “${esc(found.entry.match)}”</button>` : ''}
      <p class="note">Narration says it this way from the next time you tap Listen. Chapters already prepared for the drive keep the old way until prepared again.</p>
      <div class="sec">${esc(label)}</div>
      <div class="card"><button type="button" class="row" data-act="list" data-testid="pronounce-list"><span class="main"><b>Pronunciations for This Novel</b></span>${chevron()}</button></div>`;
  };

  const field = (): HTMLInputElement | null => p.body.querySelector<HTMLInputElement>('[data-f="say"]');
  const allNovels = (): boolean => p.body.querySelector<HTMLInputElement>('[data-f="all"]')?.checked === true;

  const load = async (): Promise<void> => {
    try {
      lists = await loadLists(novelKey);
      found = findEntry(lists.global, lists.novel, word);
      failed = false;
    } catch {
      failed = true;
    }
    render();
    if (lists && !found) field()?.focus({ preventScroll: true });
  };

  p.body.addEventListener('input', (ev) => {
    const el = ev.target as HTMLElement;
    if (el.dataset.f !== 'say') return;
    const hint = p.body.querySelector('[data-hint]');
    if (hint) hint.textContent = respellingHint((el as HTMLInputElement).value, word);
  });
  p.body.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.target as HTMLElement).dataset.f === 'say') (ev.target as HTMLInputElement).blur();
  });

  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'retry') return void load();
    if (!lists || busy) return;
    const say = field()?.value.trim() ?? '';
    if (act === 'hear') {
      const problem = respellingProblem(say);
      if (problem) return toast(problem);
      el.classList.add('is-busy');
      playing = true;
      void hear(novel, word, say)
        .catch((err: unknown) => toast(`Couldn’t play it: ${err instanceof Error ? err.message : String(err)}`, true))
        .finally(() => el.classList.remove('is-busy'));
      return;
    }
    if (act === 'save') {
      const problem = respellingProblem(say);
      if (problem) return toast(problem);
      const all = allNovels();
      busy = true;
      void writeLists(novelKey, savePronunciation(lists, word, say, all))
        .then(() => {
          toast(all ? `Saved “${word}” for all novels` : `Saved “${word}” for ${label}`);
          done();
        })
        .catch((err: unknown) => toast(`Couldn’t save: ${err instanceof Error ? err.message : String(err)}`, true))
        .finally(() => (busy = false));
      return;
    }
    if (act === 'remove' && found) {
      busy = true;
      const match = found.entry.match;
      const scope = found.scope;
      const now = lists;
      void confirmStep(`Remove “${match}”?`, 'The voices go back to saying it their own way.', 'Remove')
        .then(async (yes) => {
          if (!yes) return;
          await writeLists(novelKey, removePronunciation(now, match, scope));
          toast(`Removed “${match}”`);
          await load();
        })
        .catch((err: unknown) => toast(`Couldn’t remove it: ${err instanceof Error ? err.message : String(err)}`, true))
        .finally(() => (busy = false));
      return;
    }
    if (act === 'list') openLexiconEditor({ key: novelKey, name: label }, 'novel');
  });

  render();
  void load();
}

// ---------------------------------------------------------------- the reader's quote bar

/** The novel of each chapter the reader asked for (bridge traffic), and the last one (a fallback). */
const novels = new Map<string, NovelRef>();
let lastNovel: NovelRef | null = null;

function selectionTarget(): { word: string; chapterPath: string | null } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!el?.closest('[data-testid="reader-body"]')) return null;
  const word = pronounceTarget(sel.toString());
  if (!word) return null;
  return { word, chapterPath: el.closest<HTMLElement>('.rd-chapter[data-path]')?.dataset.path ?? null };
}

function addButton(bar: HTMLElement): HTMLButtonElement {
  let btn = bar.querySelector<HTMLButtonElement>('.tn-pronounce');
  if (btn) return btn;
  btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rd-quote-btn tap tap-dim tn-pronounce';
  btn.dataset.testid = 'reader-quote-pronounce';
  btn.innerHTML = `${icon('waveform', 16)}<span>Pronounce</span>`;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const t = selectionTarget();
    const novel = (t?.chapterPath ? novels.get(t.chapterPath) : undefined) ?? lastNovel;
    if (!t || !novel) return;
    const reader = bar.closest('[data-testid="screen-reader"]');
    const novelName = reader?.querySelector('.rd-top-novel')?.textContent ?? '';
    window.getSelection()?.removeAllRanges();
    openPronounceSheet({ word: t.word, novel, novelName });
  });
  bar.append(btn);
  return btn;
}

function refresh(): void {
  for (const bar of document.querySelectorAll<HTMLElement>('[data-testid="reader-quote-bar"]')) {
    const btn = addButton(bar);
    const t = selectionTarget();
    const show = !!t && (!!(t.chapterPath && novels.has(t.chapterPath)) || !!lastNovel);
    if (btn.hidden === show) btn.hidden = !show;
    const name = `Set pronunciation for ${t?.word ?? 'the selected word'}`;
    if (btn.getAttribute('aria-label') !== name) btn.setAttribute('aria-label', name);
  }
}

/** Install once at startup (main.ts). */
export function installPronounce(): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);
  observeCalls((method, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if ((method === 'chapter.get' || method === 'progress.save') && typeof a.pluginId === 'string' && typeof a.novelPath === 'string') {
      lastNovel = { pluginId: a.pluginId, novelPath: a.novelPath };
      if (typeof a.chapterPath === 'string') novels.set(a.chapterPath, lastNovel);
    }
  });
  let queued = false;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      refresh();
    });
  };
  // The bar comes and goes with the selection (v1 shows it 250 ms after the selection settles).
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('selectionchange', schedule);
}
