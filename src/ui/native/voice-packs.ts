/**
 * Settings › Voices › Voice packs (personal flavor): Nephis's model packs (.tnmodel files made on the PC) kept on this
 * iPhone side by side (native: NephisModelPack.swift, ExpressiveCore NephisPackLibrary.swift).
 *  - One row per pack: its name, when it was made, whether it carries her studio, its size; ✓ on the one in use.
 *    Tap a row: she reads with that pack from her next sentence (ExpressiveVoice.selectNephisPack).
 *  - Two roles (2026-10-15): narrator packs read the story, a dialogue pack reads its quoted dialogue in the same voice
 *    (NephisDialogue.swift). Without dialogue packs the page is one list, as before; with one, a Narrator section and a
 *    Dialogue section, the dialogue one with "Narrator Reads Dialogue Too" (no dialogue pack in use). A pack's role is its
 *    pack.json "role"; Edit puts "Use for Dialogue" / "Use for Narration" on every row (setNephisPackRole).
 *  - Edit (top right) puts Delete on every row; Delete asks on the row itself (never a browser dialog). Deleting hers
 *    says what she reads with next: the next pack in the list, or the voice the app came with when it was the last.
 *  - Storage: the total the packs use (350-500 MB each).
 * Opening a .tnmodel (Files, the share sheet, or the app's Documents folder) adds it and makes it hers (a dialogue pack:
 * her dialogue voice).
 */
import { formatBytes } from './drive-status.ts';
import { ExpressiveVoice } from './expressive-lab.ts';
import { esc, panel, toast } from './voices-ui.ts';

export type PackRole = 'narrator' | 'dialogue';

export interface VoicePack {
  id: string;
  name: string;
  made: string | null;
  studio: boolean;
  bytes: number;
  /** The narrator pack she reads with. */
  active: boolean;
  role: PackRole;
  /** The dialogue pack she reads quoted dialogue with. */
  dialogue: boolean;
}

export interface VoicePacks {
  packs: VoicePack[];
  totalBytes: number;
}

/** Native's answer (nephisPacks / selectNephisPack / deleteNephisPack / setNephisPackRole / selectNephisDialogue), or
 * null when it isn't one (an older build). An older build's packs are all narrator packs. */
export function normalizePacks(raw: unknown): VoicePacks | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { packs?: unknown }).packs)) return null;
  const r = raw as { packs: unknown[]; totalBytes?: unknown };
  const packs = r.packs.flatMap((p): VoicePack[] => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) return [];
    const bytes = typeof o.bytes === 'number' && Number.isFinite(o.bytes) ? o.bytes : 0;
    const role: PackRole = o.role === 'dialogue' ? 'dialogue' : 'narrator';
    return [
      {
        id: o.id,
        name: typeof o.name === 'string' && o.name.trim() ? o.name : 'Unnamed pack',
        made: typeof o.made === 'string' && o.made ? o.made : null,
        studio: o.studio === true,
        bytes,
        active: role === 'narrator' && o.active === true,
        role,
        dialogue: role === 'dialogue' && o.dialogue === true,
      },
    ];
  });
  const total = typeof r.totalBytes === 'number' && Number.isFinite(r.totalBytes) ? r.totalBytes : packs.reduce((a, p) => a + p.bytes, 0);
  return { packs, totalBytes: total };
}

/** pack.json's "made" in plain words ("Oct 11, 2026"); anything that isn't a date stays as it is. */
export function madeLabel(made: string | null): string | null {
  if (!made) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(made);
  if (!m) return made;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? made : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** A row's second line: "Made Oct 11, 2026 · Studio · 412 MB" (a dialogue pack: "Made Oct 15, 2026 · 380 MB": its
 * studio is never used, the narrator pack's is shared). */
export function packLine(p: VoicePack): string {
  const made = madeLabel(p.made);
  const studio = p.role === 'dialogue' ? null : p.studio ? 'Studio' : 'No studio';
  return [made ? `Made ${made}` : null, studio, formatBytes(p.bytes)].filter(Boolean).join(' · ');
}

/** The pack in use for a row: ✓ on the narrator pack she reads with and on the dialogue pack she reads dialogue with. */
export function inUse(p: VoicePack): boolean {
  return p.role === 'dialogue' ? p.dialogue : p.active;
}

/** What Delete asks on the row: deleting one in use says what she reads with next (native picks the next one of its
 * role in the list). */
export function deletePrompt(list: VoicePacks, id: string): string {
  const p = list.packs.find((x) => x.id === id);
  if (!p) return '';
  const size = formatBytes(p.bytes);
  if (!inUse(p)) return `Delete “${p.name}”? Frees ${size}.`;
  const next = list.packs.find((x) => x.id !== id && x.role === p.role);
  if (p.role === 'dialogue') {
    return next
      ? `Nephis reads dialogue with this pack. Delete it (frees ${size}) and switch her dialogue to “${next.name}”?`
      : `Nephis reads dialogue with this pack. Delete it (frees ${size})? Her narrator pack will read dialogue too.`;
  }
  return next
    ? `Nephis reads with this pack. Delete it (frees ${size}) and switch her to “${next.name}”?`
    : `Nephis reads with this pack. Delete it (frees ${size})? She’ll read with the voice the app came with.`;
}

/** Settings › Voices: the Voice packs row's second line ("nephis-r9 · Dialogue: dlg-1 · 3 packs · 1.3 GB"). */
export function packsSummary(list: VoicePacks | null): string {
  if (!list) return 'Her model packs on this iPhone';
  if (list.packs.length === 0) return 'None yet: open a .tnmodel file to add one';
  const active = list.packs.find((p) => p.active);
  const dialogue = list.packs.find((p) => p.dialogue);
  const n = list.packs.length;
  return [active ? active.name : 'None in use', dialogue ? `Dialogue: ${dialogue.name}` : null, `${n} pack${n === 1 ? '' : 's'}`, formatBytes(list.totalBytes)]
    .filter(Boolean)
    .join(' · ');
}

/** Settings › Voices › Voice packs. `onDone`: something changed (Settings › Voices refreshes its row). */
export function openVoicePacks(onDone: () => void = () => undefined): void {
  const p = panel('Voice Packs', 'voice-packs');
  let list: VoicePacks | null = null;
  let failed = false;
  let editing = false;
  let asking: string | null = null;
  let busy = false;

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'edit';
  edit.dataset.act = 'edit';
  edit.dataset.testid = 'voice-packs-edit';
  p.root.querySelector('.hd')?.append(edit);

  const row = (x: VoicePack): string => {
    // ✓ stays in Edit, so deleting hers is never a guess.
    const other = x.role === 'dialogue' ? 'Narration' : 'Dialogue';
    const tail = `<span class="check" aria-hidden="true">${inUse(x) ? '✓' : ''}</span>${
      editing
        ? `<button type="button" class="link" data-act="role" data-id="${esc(x.id)}" aria-label="Use ${esc(x.name)} for ${other}">For ${other}</button>` +
          `<button type="button" class="link" data-act="ask" data-id="${esc(x.id)}" style="color:#ff8a8a" aria-label="Delete ${esc(x.name)}">Delete</button>`
        : ''
    }`;
    const ask =
      asking === x.id && list
        ? `<div class="row" data-testid="voice-packs-confirm"><div class="main"><span class="sub" style="margin:0">${esc(deletePrompt(list, x.id))}</span>
            <div class="chips" style="margin-top:10px"><button type="button" class="chip" data-act="cancel">Cancel</button><button type="button" class="chip" data-act="delete" data-id="${esc(x.id)}" style="color:#ff8a8a">Delete</button></div></div></div>`
        : '';
    return `<div class="row" data-pack="${esc(x.id)}">
        <button type="button" class="main" data-act="pick" data-id="${esc(x.id)}" style="text-align:left;padding:0"${inUse(x) ? ' aria-current="true"' : ''}><b>${esc(x.name)}</b><span class="sub">${esc(packLine(x))}</span></button>
        ${tail}
      </div>${ask}`;
  };

  const render = (): void => {
    edit.textContent = editing ? 'Done' : 'Edit';
    edit.hidden = !list || list.packs.length === 0;
    if (!list) {
      p.body.innerHTML = failed
        ? '<p class="note">Voice packs aren’t available right now.</p><button type="button" class="btn alt" data-act="retry">Try Again</button>'
        : '<p class="note">Loading…</p>';
      return;
    }
    const howToAdd = 'To add one, open a .tnmodel file made on the PC: in Files or the share sheet, choose TachiNovel.';
    const narrators = list.packs.filter((x) => x.role === 'narrator');
    const dialogues = list.packs.filter((x) => x.role === 'dialogue');
    const storage = `<div class="sec">Storage</div>
      <div class="card"><div class="row" data-testid="voice-packs-total"><div class="main"><b>Total Used</b><span class="sub">Each pack is 350–500 MB. Packs aren’t in iCloud backups.</span></div><span>${esc(formatBytes(list.totalBytes))}</span></div></div>`;
    if (list.packs.length === 0) {
      p.body.innerHTML = `<p class="note" data-testid="voice-packs-empty">No voice packs yet: Nephis reads with the voice the app came with. ${esc(howToAdd)}</p>`;
    } else if (dialogues.length === 0) {
      p.body.innerHTML = `<div class="sec">On this iPhone</div><div class="card" data-testid="voice-packs-list">${narrators.map(row).join('')}</div>
      <p class="note">Nephis reads with the pack with the ✓, from her next sentence. ${esc(howToAdd)}</p>${storage}`;
    } else {
      const none = !dialogues.some((x) => x.dialogue);
      const narratorList = narrators.length
        ? narrators.map(row).join('')
        : '<div class="row"><div class="main"><span class="sub" style="margin:0">None: she narrates with the voice the app came with.</span></div></div>';
      p.body.innerHTML = `<div class="sec">Narrator</div><div class="card" data-testid="voice-packs-list">${narratorList}</div>
      <div class="sec">Dialogue</div><div class="card" data-testid="voice-packs-dialogue">${dialogues.map(row).join('')}
        <div class="row" data-testid="voice-packs-no-dialogue"><button type="button" class="main" data-act="no-dialogue" style="text-align:left;padding:0"${none ? ' aria-current="true"' : ''}><b>Narrator Reads Dialogue Too</b><span class="sub">No dialogue pack: one voice for everything</span></button>
          <span class="check" aria-hidden="true">${none ? '✓' : ''}</span></div></div>
      <p class="note">Nephis narrates with the Narrator pack with the ✓ and speaks quoted dialogue with the Dialogue pack with the ✓, in the same voice, from her next sentence. ${esc(howToAdd)}</p>${storage}`;
    }
  };

  const apply = (call: Promise<unknown>, done?: (l: VoicePacks) => void): void => {
    busy = true;
    render();
    void call
      .then((raw) => {
        const next = normalizePacks(raw);
        if (!next) throw new Error('no answer');
        list = next;
        failed = false;
        done?.(next);
        onDone();
      })
      .catch((err: unknown) => toast(`Couldn’t change the voice pack: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        busy = false;
        render();
      });
  };

  const load = (): void => {
    void ExpressiveVoice.nephisPacks()
      .then((raw) => {
        list = normalizePacks(raw);
        failed = !list;
      })
      .catch(() => {
        failed = true;
      })
      .finally(render);
  };

  p.root.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const id = el.dataset.id ?? '';
    switch (el.dataset.act ?? '') {
      case 'retry':
        failed = false;
        render();
        load();
        return;
      case 'edit':
        editing = !editing;
        asking = null;
        render();
        return;
      case 'pick': {
        const x = list?.packs.find((q) => q.id === id);
        if (!x || inUse(x) || busy || editing) return;
        apply(ExpressiveVoice.selectNephisPack({ id }), () =>
          toast(x.role === 'dialogue' ? `Nephis speaks dialogue with “${x.name}” from her next sentence.` : `Nephis reads with “${x.name}” from her next sentence.`),
        );
        return;
      }
      case 'no-dialogue': {
        if (busy || editing || !list?.packs.some((q) => q.dialogue)) return;
        apply(ExpressiveVoice.selectNephisDialogue({ id: null }), () => toast('Her narrator pack reads dialogue too, from her next sentence.'));
        return;
      }
      case 'role': {
        const x = list?.packs.find((q) => q.id === id);
        if (!x || busy) return;
        const role: 'narrator' | 'dialogue' = x.role === 'dialogue' ? 'narrator' : 'dialogue';
        apply(ExpressiveVoice.setNephisPackRole({ id, role }), () =>
          toast(role === 'dialogue' ? `“${x.name}” is a dialogue pack now.` : `“${x.name}” is a narrator pack now.`),
        );
        return;
      }
      case 'ask':
        asking = asking === id ? null : id;
        render();
        return;
      case 'cancel':
        asking = null;
        render();
        return;
      case 'delete': {
        const x = list?.packs.find((q) => q.id === id);
        if (!x || busy) return;
        asking = null;
        apply(ExpressiveVoice.deleteNephisPack({ id }), (l) => {
          if (l.packs.length === 0) editing = false;
          if (x.role === 'dialogue') {
            const now = l.packs.find((q) => q.dialogue);
            toast(x.dialogue ? (now ? `Deleted “${x.name}”. Nephis speaks dialogue with “${now.name}”.` : `Deleted “${x.name}”. Her narrator pack reads dialogue too.`) : `Deleted “${x.name}”.`);
            return;
          }
          const now = l.packs.find((q) => q.active);
          toast(x.active ? (now ? `Deleted “${x.name}”. Nephis reads with “${now.name}”.` : `Deleted “${x.name}”. Nephis reads with the voice the app came with.`) : `Deleted “${x.name}”.`);
        });
        return;
      }
      default:
    }
  });
  render();
  load();
}
