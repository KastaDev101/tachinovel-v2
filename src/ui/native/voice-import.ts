/**
 * Imported voices (personal flavor; docs/voice-import.md), shown in Settings › Voices › Expressive voices
 * (expressive-lab.ts): voices designed on the PC (tachinovel-narrator py/export_voice.py → a .tnvoice file
 * in iCloud Drive › TachiNovel-Voices), imported with the Files picker or "Open in TachiNovel", checked and
 * kept natively (ExpressiveCore VoicePack.swift, ImportedVoices.swift). The chosen one is the voice
 * Chatterbox Nano reads with; Kokoro and the Apple voice are separate settings and never change here.
 *
 * Pure functions (normalizing what native sends, the section's HTML, the messages) and the section's
 * controller (createVoiceSection), which the lab creates only in the personal flavor, so the store flavor's
 * bundle drops all of this.
 */

export interface ImportedVoiceInfo {
  id: string;
  name: string;
  createdAt: string | null;
  importedAt: string | null;
  hasPreview: boolean;
  madeFor: string | null;
  sourceFile: string | null;
  /** Ships with the app (BuiltInVoices/): can be chosen, not renamed or deleted. */
  bundled: boolean;
  /** The shipped default narrator voice. */
  isDefault: boolean;
}

export interface VoicesInfo {
  engineTitle: string;
  importEnabled: boolean;
  /** The default narrator voice: a shipped voice's id, or "builtin" (Chatterbox Nano's own voice). */
  defaultVoice: string;
  /** The chosen narrator voice ("builtin" or an id); null = the default voice. */
  selected: string | null;
  /** The chosen voice's files are gone: Chatterbox Nano falls back to the default voice. */
  selectedMissing: boolean;
  /** The voice the loaded model speaks with ("builtin" or an id), null when Chatterbox Nano isn't loaded. */
  loaded: string | null;
  /** Why the last load didn't use the chosen voice. */
  note: string | null;
  /** Shipped voices (default first), then imported ones. */
  list: ImportedVoiceInfo[];
}

/** UI state of the section that survives the lab's 1 s re-render. */
export interface VoicesUiState {
  /** "voice-delete:<id>" while a delete waits for its second tap. */
  armed: string;
  /** Id of the voice being renamed, '' if none. */
  renaming: string;
  renameDraft: string;
}

/** Chatterbox Nano's own voice (the model's voice-default.safetensors), always selectable. */
export const BUILT_IN = 'builtin';
export const ENGINE_VOICE_NAME = 'Original Chatterbox voice';
/** "v…" imported, "b…" shipped with the app. */
const ID = /^[vb][0-9a-f]{16}$/;
export const MAX_NAME = 40;

const str = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x : null);

/** What native's status().voices says, or null (an older app without voice import, or nothing usable). */
export function normalizeVoices(raw: unknown): VoicesInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.list)) return null;
  const list: ImportedVoiceInfo[] = [];
  for (const item of r.list as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const id = str(v.id);
    if (!id || !ID.test(id) || list.some((x) => x.id === id)) continue;
    const bundled = id.startsWith('b');
    list.push({
      id,
      name: cleanVoiceName(typeof v.name === 'string' ? v.name : ''),
      createdAt: str(v.createdAt),
      importedAt: str(v.importedAt),
      hasPreview: v.hasPreview === true,
      madeFor: str(v.madeFor),
      sourceFile: str(v.sourceFile),
      bundled,
      isDefault: bundled && v.isDefault === true,
    });
  }
  const known = (id: string | null): id is string => id === BUILT_IN || (!!id && list.some((v) => v.id === id));
  const selected = str(r.selected);
  const fallback = str(r.default);
  const loaded = str(r.loaded);
  const validSelection = selected === BUILT_IN || (!!selected && ID.test(selected));
  return {
    engineTitle: str(r.engineTitle) ?? 'Chatterbox Nano',
    importEnabled: r.importEnabled === true,
    // Only a shipped voice (or Chatterbox's own) can be the default.
    defaultVoice: fallback && list.some((v) => v.id === fallback && v.bundled) ? fallback : BUILT_IN,
    selected: validSelection ? selected : null,
    selectedMissing: r.selectedMissing === true || (validSelection && !known(selected)),
    loaded: known(loaded) ? loaded : null,
    note: str(r.note),
    list,
  };
}

/** The same cleaning as native (VoicePack.cleanName): no control characters, single spaces, ≤ 40 characters. */
export function cleanVoiceName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const spaced = raw.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, ' ');
  const collapsed = spaced.split(/\s+/).filter(Boolean).join(' ');
  const cut = [...collapsed].slice(0, MAX_NAME).join('').trim();
  return cut || 'Imported voice';
}

/** A rename the user typed: the cleaned name, or a reason it can't be saved. */
export function renameProblem(draft: string): string | null {
  return draft.trim() ? null : 'Type a name.';
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** "6 Oct 2026" from an ISO date (UTC, so tests and phones agree), '' if unreadable. */
export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

/** The voice Chatterbox Nano reads with right now ("builtin" or an id). */
export function effectiveVoice(info: VoicesInfo): string {
  return info.selected && !info.selectedMissing ? info.selected : info.defaultVoice;
}

export function voiceName(info: VoicesInfo, id: string | null): string {
  const target = id ?? info.defaultVoice;
  if (target === BUILT_IN) return ENGINE_VOICE_NAME;
  return info.list.find((v) => v.id === target)?.name ?? 'Unknown voice';
}

function row(info: VoicesInfo, ui: VoicesUiState, id: string, name: string, sub: string, editable: boolean): string {
  const inUse = effectiveVoice(info) === id;
  const tags = [
    inUse ? '<span class="xtag">Narrator voice</span>' : '',
    info.defaultVoice === id ? '<span class="xtag">Default</span>' : '',
    info.loaded === id ? '<span class="xtag">loaded</span>' : '',
  ].join('');
  const acts = [
    `<button type="button" data-act="voice-play" data-id="${esc(id)}" aria-label="Play a sample of ${esc(name)}">▶ Play</button>`,
    inUse ? '' : `<button type="button" data-act="voice-use" data-id="${esc(id)}" aria-label="Use ${esc(name)} as the narrator voice">Use</button>`,
    editable && ui.renaming !== id ? `<button type="button" data-act="voice-rename" data-id="${esc(id)}" aria-label="Rename ${esc(name)}">Rename</button>` : '',
    !editable
      ? ''
      : ui.armed === `voice-delete:${id}`
        ? `<button type="button" class="warn" data-act="voice-delete" data-id="${esc(id)}">Tap again: delete “${esc(name)}”</button>`
        : `<button type="button" data-act="voice-arm-delete" data-id="${esc(id)}" aria-label="Delete ${esc(name)}">Delete</button>`,
  ].join('');
  const rename =
    editable && ui.renaming === id
      ? `<div class="acts" data-testid="xvoice-rename">
          <input type="text" data-act-input="voice-name" maxlength="${MAX_NAME}" autocomplete="off" aria-label="New name for ${esc(name)}" value="${esc(ui.renameDraft)}">
          <button type="button" class="on" data-act="voice-rename-save" data-id="${esc(id)}">Save name</button>
          <button type="button" data-act="voice-rename-cancel">Cancel</button>
        </div>`
      : '';
  return `<div class="xv-row" data-voice="${esc(id)}">
      <div><b>${esc(name)}</b>${tags}</div>
      <div class="muted">${esc(sub)}</div>
      <div class="acts">${acts}</div>${rename}
    </div>`;
}

/**
 * Settings › Voices › Expressive voices › "Narrator voice": the voices that ship with the app (default first),
 * Chatterbox's own voice, the imported ones, Import voice….
 */
export function voicesSection(info: VoicesInfo, ui: VoicesUiState): string {
  const fallback = info.selectedMissing
    ? `Your narrator voice isn’t on this iPhone any more, so Chatterbox Nano uses the default voice (${voiceName(info, null)}). Pick another voice or import it again.`
    : info.note;
  const preview = (v: ImportedVoiceInfo): string => (v.hasPreview ? 'has a preview' : 'no preview: ▶ uses the model');
  const shipped = info.list.filter((v) => v.bundled);
  const imported = info.list.filter((v) => !v.bundled);
  const rows = [
    ...shipped.map((v) => row(info, ui, v.id, v.name, `Comes with TachiNovel · ${preview(v)}`, false)),
    row(info, ui, BUILT_IN, ENGINE_VOICE_NAME, `Comes with the ${info.engineTitle} download`, false),
    ...imported.map((v) => row(info, ui, v.id, v.name, `${v.importedAt ? `Imported ${shortDate(v.importedAt)}` : 'Imported'} · ${preview(v)}`, true)),
  ].join('');
  const importButton = info.importEnabled
    ? '<div class="acts"><button type="button" class="on" data-act="voice-import">Import voice…</button></div>'
    : '<div class="muted">Importing voices isn’t part of this build.</div>';
  return `<h2>Narrator voice (${esc(info.engineTitle)})</h2>
    <div class="card" data-testid="xvoices">
      <div class="muted">The narrator voice is what ${esc(info.engineTitle)} reads with: one that comes with TachiNovel, ${esc(info.engineTitle)}’s own, or one you designed on the PC. Kokoro and the Apple voice stay as they are.</div>
      ${fallback ? `<div class="err" data-testid="xvoices-note">${esc(fallback)}</div>` : ''}
      ${rows}
      ${importButton}
      <div class="muted">Make a .tnvoice file with export_voice.py on the PC (it saves to iCloud Drive › TachiNovel-Voices), then Import voice…, or open the file in Files and share it to TachiNovel.</div>
    </div>`;
}

/** The message after importVoice() answered (cancelled: none). */
export function importMessage(result: unknown): string {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  if (r.cancelled === true || !r.voice || typeof r.voice !== 'object') return '';
  const v = r.voice as Record<string, unknown>;
  const name = cleanVoiceName(typeof v.name === 'string' ? v.name : '');
  return r.replaced === true ? `“${name}” was already imported; it kept its name.` : `Imported “${name}”. Tap Use to make it the narrator voice.`;
}

/** The message after playVoiceSample() answered. */
export function sampleMessage(result: unknown, name: string): string {
  const played = result && typeof result === 'object' ? (result as Record<string, unknown>).played : undefined;
  if (played === 'preview') return `Playing the preview of “${name}”.`;
  return `“${name}” through Chatterbox Nano: Kokoro reads until the model has loaded.`;
}

/** An "Open in TachiNovel" result (native event "voiceImport"). */
export function importEventMessage(e: unknown): { message: string; error: boolean } {
  const r = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  const ok = r.ok === true;
  const message = typeof r.message === 'string' && r.message.trim() ? r.message.trim().slice(0, 400) : ok ? 'Voice imported.' : 'Couldn’t import the voice.';
  return { message, error: !ok };
}

type Obj = Record<string, unknown>;

/** The ExpressiveVoice plugin methods the section calls (expressive-lab.ts registers the plugin). */
export interface VoicePluginApi {
  importVoice(): Promise<Obj>;
  selectVoice(o: { id: string | null }): Promise<Obj>;
  renameVoice(o: { id: string; name: string }): Promise<Obj>;
  deleteVoice(o: { id: string }): Promise<Obj>;
  playVoiceSample(o: { id: string | null }): Promise<Obj>;
}

/** What the section needs from the lab screen. */
export interface VoiceSectionHost {
  plugin: VoicePluginApi;
  /** The latest status() from native. */
  status(): Obj;
  /** A call answering with the status: optimistic message, then the new status (or the error) and a render. */
  apply(p: Promise<Obj>, okMessage: string): void;
  /** A call answering with something else: `done` turns the answer into the message. */
  call(p: Promise<Obj>, done: (r: Obj) => string): void;
  message(text: string, error: boolean): void;
  render(): void;
  root: HTMLElement;
}

export interface VoiceSection {
  view(): string;
  /** Handles a tap on one of the section's [data-act]s; false for anything else. */
  click(act: string, id: string): boolean;
  input(el: HTMLElement): void;
  key(ev: KeyboardEvent): void;
  /** A rename is open: the lab must not re-render under the user's fingers. */
  editing(): boolean;
}

export function createVoiceSection(host: VoiceSectionHost): VoiceSection {
  const ui: VoicesUiState = { armed: '', renaming: '', renameDraft: '' };
  const info = (): VoicesInfo | null => normalizeVoices(host.status().voices);
  const nameOf = (id: string | null): string => {
    const i = info();
    return i ? voiceName(i, id) : 'The voice';
  };
  const save = (id: string): void => {
    const problem = renameProblem(ui.renameDraft);
    if (problem) return host.message(problem, true);
    const name = cleanVoiceName(ui.renameDraft);
    ui.renaming = '';
    (document.activeElement as HTMLElement | null)?.blur();
    host.apply(host.plugin.renameVoice({ id, name }), `Renamed to “${name}”.`);
  };
  return {
    view() {
      const i = info();
      return i ? voicesSection(i, ui) : '';
    },
    click(act, id) {
      if (act !== 'voice-delete') ui.armed = '';
      switch (act) {
        case 'voice-import':
          host.call(host.plugin.importVoice(), importMessage);
          return true;
        case 'voice-use':
          host.apply(host.plugin.selectVoice({ id }), `“${nameOf(id)}” is the narrator voice now.`);
          return true;
        case 'voice-play': {
          const name = nameOf(id);
          host.call(host.plugin.playVoiceSample({ id }), (r) => sampleMessage(r, name));
          return true;
        }
        case 'voice-rename':
          ui.renaming = id;
          ui.renameDraft = nameOf(id);
          host.render();
          host.root.querySelector<HTMLInputElement>('[data-act-input="voice-name"]')?.focus();
          return true;
        case 'voice-rename-save':
          save(id);
          return true;
        case 'voice-rename-cancel':
          ui.renaming = '';
          host.render();
          return true;
        case 'voice-arm-delete':
          ui.armed = `voice-delete:${id}`;
          host.render();
          return true;
        case 'voice-delete':
          ui.armed = '';
          host.apply(host.plugin.deleteVoice({ id }), `Deleted “${nameOf(id)}”.`);
          return true;
        default:
          return false;
      }
    },
    input(el) {
      if (el.dataset.actInput === 'voice-name') ui.renameDraft = (el as HTMLInputElement).value;
    },
    key(ev) {
      if ((ev.target as HTMLElement).dataset.actInput === 'voice-name' && ev.key === 'Enter') {
        ev.preventDefault();
        save(ui.renaming);
      }
    },
    editing: () => ui.renaming !== '',
  };
}
