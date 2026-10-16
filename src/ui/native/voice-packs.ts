/**
 * Settings › Voices › Voice packs (personal flavor): Nephis's model packs (.tnmodel files made on the PC) kept on this
 * iPhone side by side (native: NephisModelPack.swift, ExpressiveCore NephisPackLibrary.swift).
 *  - One row per pack: its name, when it was made, whether it carries her studio, its size; ✓ on the one she reads
 *    with. Tap a row: she reads with that pack from her next sentence (ExpressiveVoice.selectNephisPack).
 *  - Edit (top right) puts Delete on every row; Delete asks on the row itself (never a browser dialog). Deleting hers
 *    says what she reads with next: the next pack in the list, or the voice the app came with when it was the last.
 *  - Storage: the total the packs use (350-500 MB each).
 * Opening a .tnmodel (Files, the share sheet, or the app's Documents folder) adds it and makes it hers.
 */
import { formatBytes } from './drive-status.ts';
import { ExpressiveVoice } from './expressive-lab.ts';
import { esc, panel, toast } from './voices-ui.ts';

export interface VoicePack {
  id: string;
  name: string;
  made: string | null;
  studio: boolean;
  bytes: number;
  active: boolean;
}

export interface VoicePacks {
  packs: VoicePack[];
  totalBytes: number;
}

/** Native's answer (nephisPacks / selectNephisPack / deleteNephisPack), or null when it isn't one (an older build). */
export function normalizePacks(raw: unknown): VoicePacks | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { packs?: unknown }).packs)) return null;
  const r = raw as { packs: unknown[]; totalBytes?: unknown };
  const packs = r.packs.flatMap((p): VoicePack[] => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) return [];
    const bytes = typeof o.bytes === 'number' && Number.isFinite(o.bytes) ? o.bytes : 0;
    return [
      {
        id: o.id,
        name: typeof o.name === 'string' && o.name.trim() ? o.name : 'Unnamed pack',
        made: typeof o.made === 'string' && o.made ? o.made : null,
        studio: o.studio === true,
        bytes,
        active: o.active === true,
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

/** A row's second line: "Made Oct 11, 2026 · Studio · 412 MB". */
export function packLine(p: VoicePack): string {
  const made = madeLabel(p.made);
  return [made ? `Made ${made}` : null, p.studio ? 'Studio' : 'No studio', formatBytes(p.bytes)].filter(Boolean).join(' · ');
}

/** What Delete asks on the row: deleting hers says what she reads with next (native picks the next one in the list). */
export function deletePrompt(list: VoicePacks, id: string): string {
  const p = list.packs.find((x) => x.id === id);
  if (!p) return '';
  const size = formatBytes(p.bytes);
  if (!p.active) return `Delete “${p.name}”? Frees ${size}.`;
  const next = list.packs.find((x) => x.id !== id);
  return next
    ? `Nephis reads with this pack. Delete it (frees ${size}) and switch her to “${next.name}”?`
    : `Nephis reads with this pack. Delete it (frees ${size})? She’ll read with the voice the app came with.`;
}

/** Settings › Voices: the Voice packs row's second line ("nephis-r9 · 3 packs · 1.3 GB"). */
export function packsSummary(list: VoicePacks | null): string {
  if (!list) return 'Her model packs on this iPhone';
  if (list.packs.length === 0) return 'None yet: open a .tnmodel file to add one';
  const active = list.packs.find((p) => p.active);
  const n = list.packs.length;
  return [active ? active.name : 'None in use', `${n} pack${n === 1 ? '' : 's'}`, formatBytes(list.totalBytes)].join(' · ');
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
    const tail = `<span class="check" aria-hidden="true">${x.active ? '✓' : ''}</span>${
      editing ? `<button type="button" class="link" data-act="ask" data-id="${esc(x.id)}" style="color:#ff8a8a" aria-label="Delete ${esc(x.name)}">Delete</button>` : ''
    }`;
    const ask =
      asking === x.id && list
        ? `<div class="row" data-testid="voice-packs-confirm"><div class="main"><span class="sub" style="margin:0">${esc(deletePrompt(list, x.id))}</span>
            <div class="chips" style="margin-top:10px"><button type="button" class="chip" data-act="cancel">Cancel</button><button type="button" class="chip" data-act="delete" data-id="${esc(x.id)}" style="color:#ff8a8a">Delete</button></div></div></div>`
        : '';
    return `<div class="row" data-pack="${esc(x.id)}">
        <button type="button" class="main" data-act="pick" data-id="${esc(x.id)}" style="text-align:left;padding:0"${x.active ? ' aria-current="true"' : ''}><b>${esc(x.name)}</b><span class="sub">${esc(packLine(x))}</span></button>
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
    p.body.innerHTML =
      list.packs.length === 0
        ? `<p class="note" data-testid="voice-packs-empty">No voice packs yet: Nephis reads with the voice the app came with. ${esc(howToAdd)}</p>`
        : `<div class="sec">On this iPhone</div><div class="card" data-testid="voice-packs-list">${list.packs.map(row).join('')}</div>
      <p class="note">Nephis reads with the pack with the ✓, from her next sentence. ${esc(howToAdd)}</p>
      <div class="sec">Storage</div>
      <div class="card"><div class="row" data-testid="voice-packs-total"><div class="main"><b>Total Used</b><span class="sub">Each pack is 350–500 MB. Packs aren’t in iCloud backups.</span></div><span>${esc(formatBytes(list.totalBytes))}</span></div></div>`;
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
        if (!x || x.active || busy || editing) return;
        apply(ExpressiveVoice.selectNephisPack({ id }), () => toast(`Nephis reads with “${x.name}” from her next sentence.`));
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
