/**
 * Settings › Reader › Text Cleanup: rules that hide junk paragraphs ("Read at …", translator credits,
 * Patreon plugs) in chapter text. Rules live in `settings.cleanupRules` and are applied script-side.
 * Each rule can be switched off, edited in a sheet (pattern, regex, scope), tried on a recently read
 * chapter (`cleanup.test`), and deleted by swiping left or touching and holding.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CleanupRule, HistoryEntry } from '../../shared/contracts/domain.ts';
import { bridge, errorText, toUiError, type UiError } from '../bridge/client.ts';
import { BarButton, Button, Row, Section, SelectRow, Switch, SwitchRow } from '../components/controls.tsx';
import { ErrorState, SkeletonRows } from '../components/feedback.tsx';
import { useAsync } from '../components/hooks.ts';
import { Screen } from '../components/screen.tsx';
import { Sheet } from '../components/sheet.tsx';
import { plural } from '../lib/format.ts';
import { attachLongPress, haptic, VelocityTracker } from '../lib/gestures.ts';
import { actionSheet } from '../state/actions.ts';
import { patchSettings, settings, sources } from '../state/store.ts';
import { showToast } from '../state/toast.ts';
import '../styles/extras.css';

export interface CleanupPreset {
  id: string;
  label: string;
  pattern: string;
  regex: boolean;
  /** A line it hides (shown under the suggestion). */
  example: string;
}

/** Suggested rules: listed until added, added rules start enabled. Regexes are matched case-insensitively. */
export const CLEANUP_PRESETS: readonly CleanupPreset[] = [
  { id: 'read-at', label: 'Read at …', pattern: String.raw`^\W*read (?:\w+ ){0,3}(?:at|on) \S+\.[a-z]{2,}`, regex: true, example: 'Read at novelsite.com for the fastest updates' },
  { id: 'translator', label: 'Translator:', pattern: 'Translator:', regex: false, example: 'Translator: Mira · Editor: Kael' },
  { id: 'patreon', label: 'Support us on Patreon', pattern: String.raw`support (?:us|me|the \w+) on patreon`, regex: true, example: 'Support us on Patreon for 10 advance chapters!' },
  { id: 'visit', label: 'Visit … for the latest chapters', pattern: String.raw`visit \S+ for (?:the )?(?:latest|newest|fastest)`, regex: true, example: 'Visit novelsite.com for the latest chapters' },
];

export function presetFor(rule: Pick<CleanupRule, 'id' | 'pattern' | 'regex'>): CleanupPreset | undefined {
  return CLEANUP_PRESETS.find((p) => rule.id === `preset-${p.id}` || (p.pattern === rule.pattern && p.regex === rule.regex));
}

/** Why a pattern can't be saved, or null when it's fine. */
export function patternError(pattern: string, regex: boolean): string | null {
  if (!pattern.trim()) return null;
  if (!regex) return pattern.trim().length < 2 ? 'Use at least 2 characters.' : null;
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid regular expression.';
  }
  return re.test('') ? 'This pattern matches empty text, so it would hide every paragraph.' : null;
}

function scopeName(scope: string): string {
  return scope === '*' ? 'All sources' : (sources.value.find((s) => s.id === scope)?.name ?? scope);
}

// ---------- import / export ----------

type RuleData = Omit<CleanupRule, 'id'>;

/** Shareable JSON for a set of rules (ids are local, so they're left out). */
export function exportRules(rules: readonly CleanupRule[]): string {
  const list: RuleData[] = rules.map(({ pattern, regex, scope, enabled }) => ({ pattern, regex, scope, enabled }));
  return JSON.stringify({ app: 'TachiNovel', kind: 'cleanupRules', version: 1, rules: list }, null, 2);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Rules from pasted text: an export, or a bare array of rules. Invalid entries are dropped. */
export function parseRules(text: string): { rules: RuleData[]; dropped: number } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'That isn’t valid rule text. Paste it exactly as it was shared.' };
  }
  const list: unknown = Array.isArray(data) ? data : isRecord(data) ? data['rules'] : undefined;
  if (!Array.isArray(list)) return { error: 'No rules found in that text.' };
  const rules: RuleData[] = [];
  for (const r of list) {
    if (!isRecord(r) || typeof r['pattern'] !== 'string' || !r['pattern'].trim()) continue;
    const pattern = r['pattern'];
    const regex = r['regex'] === true;
    if (patternError(pattern, regex)) continue;
    const scope = typeof r['scope'] === 'string' && r['scope'] ? r['scope'] : '*';
    rules.push({ pattern, regex, scope, enabled: r['enabled'] !== false });
  }
  if (rules.length === 0) return { error: 'None of those rules can be used.' };
  return { rules, dropped: list.length - rules.length };
}

const sameRule = (a: RuleData, b: RuleData): boolean => a.pattern === b.pattern && a.regex === b.regex && a.scope === b.scope;

/** Appends the rules that aren't already there (same pattern, type and scope). */
export function mergeRules(existing: readonly CleanupRule[], incoming: readonly RuleData[], newId: () => string): { next: CleanupRule[]; added: number; skipped: number } {
  const next = [...existing];
  let added = 0;
  for (const r of incoming) {
    if (next.some((x) => sameRule(x, r))) continue;
    const preset = presetFor({ id: '', pattern: r.pattern, regex: r.regex });
    const id = preset && r.scope === '*' && !next.some((x) => x.id === `preset-${preset.id}`) ? `preset-${preset.id}` : newId();
    next.push({ id, ...r });
    added++;
  }
  return { next, added, skipped: incoming.length - added };
}

function ruleTitle(r: CleanupRule): string {
  return presetFor(r)?.label ?? r.pattern;
}

/**
 * Where a rule matches inside one paragraph: [start, end) ranges in order, case-insensitive, like the
 * script's matching. Empty regex matches are skipped; an invalid regex matches nothing.
 */
export function matchRanges(text: string, rule: Pick<CleanupRule, 'pattern' | 'regex'>): [number, number][] {
  const out: [number, number][] = [];
  if (rule.regex) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'gi');
    } catch {
      return out;
    }
    for (let m = re.exec(text); m !== null && out.length < 100; m = re.exec(text)) {
      if (m[0] === '') re.lastIndex++;
      else out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }
  const p = rule.pattern.trim().toLowerCase();
  const t = text.toLowerCase();
  // Lowercasing can change the length of some characters; then the offsets would be wrong.
  if (!p || t.length !== text.length) return out;
  for (let i = t.indexOf(p); i >= 0 && out.length < 100; i = t.indexOf(p, i + p.length)) out.push([i, i + p.length]);
  return out;
}

/** The paragraph with its matches marked; long text before the first match is cut to "…" so the match stays in view. */
function Highlighted(props: { text: string; ranges: [number, number][] }) {
  const { text, ranges } = props;
  const first = ranges[0]?.[0] ?? 0;
  const from = first > 60 ? text.lastIndexOf(' ', first - 30) + 1 : 0;
  const parts: ComponentChildren[] = from > 0 ? ['…'] : [];
  let at = from;
  for (const [a, b] of ranges) {
    if (b <= at) continue;
    const start = Math.max(a, at);
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark class="cleanup-mark" key={start}>
        {text.slice(start, b)}
      </mark>,
    );
    at = b;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function newRuleId(): string {
  return `rule-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

// ---------- swipe-to-delete row ----------

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const ACTION_W = 84;

/** Row that slides left to reveal Delete; a long swipe deletes right away. Touch-action pan-y keeps vertical scrolling native. */
function SwipeRow(props: { id: string; onDelete: () => void; children: ComponentChildren; testId?: string }) {
  const content = useRef<HTMLDivElement>(null);
  const onDelete = useRef(props.onDelete);
  onDelete.current = props.onDelete;

  useEffect(() => {
    const el = content.current;
    if (!el) return;
    let offset = 0;
    let sx = 0;
    let sy = 0;
    let start = 0;
    let pointer = -1;
    let decided = false;
    let horizontal = false;
    let swallowClick = false;
    let lastMoveAt = 0;
    const vt = new VelocityTracker();

    const set = (x: number, animate: boolean): void => {
      offset = x;
      el.style.transition = animate && !reducedMotion() ? 'transform 320ms var(--ease-ios)' : 'none';
      el.style.transform = x === 0 ? '' : `translate3d(${x}px,0,0)`;
      el.parentElement?.classList.toggle('is-swiped', x < 0);
    };
    const down = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest('input')) return;
      pointer = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      start = offset;
      decided = false;
      horizontal = false;
      vt.reset();
    };
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== pointer) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!decided) {
        if (Math.abs(dx) + Math.abs(dy) < 8) return;
        decided = true;
        horizontal = Math.abs(dx) > Math.abs(dy) * 1.2 && (dx < 0 || start < 0);
        if (horizontal) {
          el.setPointerCapture(e.pointerId);
          el.querySelector('.is-pressed')?.classList.remove('is-pressed');
        }
      }
      if (!horizontal) return;
      let x = start + dx;
      if (x > 0) x = Math.sqrt(x) * 2; // rubber band
      set(Math.max(-el.offsetWidth, x), false);
      vt.add(x);
      lastMoveAt = performance.now();
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== pointer) return;
      pointer = -1;
      if (!horizontal) {
        // A tap on an open row closes it instead of opening the editor.
        if (offset < 0) {
          swallowClick = true;
          set(0, true);
        }
        return;
      }
      swallowClick = true;
      // Holding still before letting go is not a fling.
      const v = performance.now() - lastMoveAt > 90 ? 0 : vt.velocity();
      const w = el.offsetWidth;
      if (offset < -w * 0.55 || (v < -1.4 && offset < -ACTION_W)) {
        set(-w, true);
        haptic();
        window.setTimeout(() => onDelete.current(), 200);
      } else if (offset < -ACTION_W / 2 || (v < -0.35 && offset < 0)) set(-ACTION_W, true);
      else set(0, true);
    };
    const click = (e: MouseEvent): void => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('click', click, true);
    };
  }, []);

  return (
    <div class="swipe-row" data-rule={props.id} data-testid={props.testId}>
      <button type="button" class="swipe-action tap tap-dim" onClick={() => props.onDelete()} aria-label="Delete rule" tabIndex={-1}>
        Delete
      </button>
      <div class="swipe-content" ref={content}>
        {props.children}
      </div>
    </div>
  );
}

// ---------- page ----------

export function CleanupPage() {
  const rules = settings.value.cleanupRules;
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const listRef = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState<{ n: number; open: boolean; rule: CleanupRule | null }>({ n: 0, open: false, rule: null });

  const save = (next: CleanupRule[]): void => patchSettings({ cleanupRules: next });
  const openEditor = (rule: CleanupRule | null): void => setSheet((s) => ({ n: s.n + 1, open: true, rule }));

  function upsert(rule: CleanupRule): void {
    const list = rulesRef.current;
    save(list.some((r) => r.id === rule.id) ? list.map((r) => (r.id === rule.id ? rule : r)) : [...list, rule]);
  }

  function setEnabled(rule: CleanupRule, enabled: boolean): void {
    save(rulesRef.current.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
  }

  function remove(rule: CleanupRule): void {
    const list = rulesRef.current;
    const index = list.findIndex((r) => r.id === rule.id);
    if (index < 0) return;
    save(list.filter((r) => r.id !== rule.id));
    showToast(`Deleted “${ruleTitle(rule)}”`, {
      undo: () => {
        const cur = rulesRef.current.filter((r) => r.id !== rule.id);
        save([...cur.slice(0, index), rule, ...cur.slice(index)]);
      },
    });
  }

  function addPreset(p: CleanupPreset): void {
    upsert({ id: `preset-${p.id}`, pattern: p.pattern, regex: p.regex, scope: '*', enabled: true });
    showToast(`Added “${p.label}”`);
  }

  async function menu(rule: CleanupRule): Promise<void> {
    const actions = [{ title: 'Edit' }, { title: rule.enabled ? 'Turn Off' : 'Turn On' }, { title: 'Delete', destructive: true }];
    const i = await actionSheet({ title: ruleTitle(rule), actions });
    if (i === 0) openEditor(rule);
    else if (i === 1) setEnabled(rule, !rule.enabled);
    else if (i === 2) remove(rule);
  }

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    return attachLongPress(el, '[data-rule]', (t) => {
      const r = rulesRef.current.find((x) => x.id === t.dataset['rule']);
      if (r) void menu(r);
    });
  }, [rules.length > 0]);

  const suggestions = CLEANUP_PRESETS.filter((p) => !rules.some((r) => presetFor(r) === p));
  const [importOpen, setImportOpen] = useState(false);

  async function moreMenu(): Promise<void> {
    const actions = [...(rules.length > 0 ? [{ title: 'Share Rules…' }] : []), { title: 'Import Rules…' }];
    const i = await actionSheet({ title: 'Text Cleanup Rules', message: 'Share your rules as text, or paste rules someone shared.', actions });
    const t = actions[i]?.title;
    if (t === 'Share Rules…') {
      void bridge()
        .call('native.share', { text: exportRules(rulesRef.current) })
        .catch(() => undefined);
    } else if (t === 'Import Rules…') setImportOpen(true);
  }

  function importRules(incoming: readonly RuleData[], dropped: number): void {
    const r = mergeRules(rulesRef.current, incoming, newRuleId);
    if (r.added > 0) save(r.next);
    const notes = [r.skipped > 0 ? `${r.skipped} already there` : '', dropped > 0 ? `${dropped} invalid` : ''].filter(Boolean).join(', ');
    showToast(`Imported ${plural(r.added, 'rule')}${notes ? ` (${notes})` : ''}`);
  }

  return (
    <Screen
      class="is-grouped"
      title="Text Cleanup"
      back="Reader"
      testId="screen-cleanup"
      right={
        <>
          <BarButton icon="ellipsis.circle" label="Share or import rules" onClick={() => void moreMenu()} testId="cleanup-more" />
          <BarButton icon="plus" label="Add rule" onClick={() => openEditor(null)} testId="add-rule" />
        </>
      }
    >
      <div class="grouped">
        <div ref={listRef}>
          <Section
            header="Rules"
            footer={
              rules.length > 0
                ? 'Matching paragraphs are hidden when a chapter opens. Swipe left on a rule, or touch and hold it, to delete it.'
                : 'Hide junk paragraphs like “Read at …” notices, translator credits and Patreon plugs.'
            }
          >
            {rules.length === 0 ? (
              <Row title="No rules yet" subtitle="Add one, or start with a suggestion below." disabled testId="cleanup-empty" />
            ) : (
              rules.map((r) => {
                const preset = presetFor(r);
                return (
                  <SwipeRow key={r.id} id={r.id} onDelete={() => remove(r)} testId="cleanup-rule">
                    <div class={`row cleanup-rule${r.enabled ? '' : ' is-off'}`}>
                      <button type="button" class="cleanup-rule-main tap tap-dim" onClick={() => openEditor(r)}>
                        <span class="row-main">
                          <span class={`row-title${r.regex && !preset ? ' cleanup-code' : ''}`}>{ruleTitle(r)}</span>
                          <span class="row-subtitle">
                            {r.regex ? 'Regular expression' : 'Contains text'} · {scopeName(r.scope)}
                          </span>
                        </span>
                      </button>
                      <Switch checked={r.enabled} onChange={(v) => setEnabled(r, v)} label={`Enable ${ruleTitle(r)}`} />
                    </div>
                  </SwipeRow>
                );
              })
            )}
          </Section>
        </div>

        {suggestions.length > 0 && (
          <Section header="Suggested" footer="Common junk lines. Added rules can be edited or switched off.">
            {suggestions.map((p) => (
              <Row
                key={p.id}
                title={p.label}
                subtitle={`“${p.example}”`}
                trailing={
                  <Button variant="tinted" size="small" onClick={() => addPreset(p)} label={`Add ${p.label}`}>
                    Add
                  </Button>
                }
                testId={`preset-${p.id}`}
              />
            ))}
          </Section>
        )}
      </div>

      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} onImport={importRules} />
      <RuleSheet
        key={sheet.n}
        open={sheet.open}
        rule={sheet.rule}
        onClose={() => setSheet((s) => ({ ...s, open: false }))}
        onSave={upsert}
        onDelete={(r) => remove(r)}
      />
    </Screen>
  );
}

// ---------- import sheet ----------

function ImportSheet(props: { open: boolean; onClose: () => void; onImport: (rules: RuleData[], dropped: number) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  function submit(): void {
    const r = parseRules(text);
    if ('error' in r) {
      setError(r.error);
      return;
    }
    props.onImport(r.rules, r.dropped);
    setText('');
    setError('');
    props.onClose();
  }
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Import Rules" detents={['fit']} testId="import-sheet">
      <div class="sheet-pad add-source">
        <textarea
          class="text-input code-input"
          placeholder="Paste rules shared from TachiNovel…"
          value={text}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setError('');
          }}
          spellcheck={false}
          data-testid="import-text"
        />
        {error && (
          <p class="form-error" data-testid="import-error">
            {error}
          </p>
        )}
        <p class="form-note">Rules you already have are skipped. Imported rules start the way they were shared (on or off).</p>
        <Button variant="filled" size="large" onClick={submit} disabled={!text.trim()}>
          Import
        </Button>
      </div>
    </Sheet>
  );
}

// ---------- add / edit sheet ----------

function RuleSheet(props: { open: boolean; rule: CleanupRule | null; onClose: () => void; onSave: (r: CleanupRule) => void; onDelete: (r: CleanupRule) => void }) {
  const r = props.rule;
  const [id] = useState(() => r?.id ?? newRuleId());
  const [pattern, setPattern] = useState(r?.pattern ?? '');
  const [regex, setRegex] = useState(r?.regex ?? false);
  const [scope, setScope] = useState(r?.scope ?? '*');
  const error = patternError(pattern, regex);
  const valid = pattern.trim() !== '' && error === null;
  const draft: CleanupRule = { id, pattern: regex ? pattern : pattern.trim(), regex, scope, enabled: r?.enabled ?? true };
  const scopeOptions = [{ value: '*', label: 'All sources' }, ...sources.value.map((s) => ({ value: s.id, label: s.name }))];
  if (!scopeOptions.some((o) => o.value === scope)) scopeOptions.push({ value: scope, label: scope });

  function save(): void {
    if (!valid) return;
    props.onSave(draft);
    props.onClose();
  }

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={r ? 'Edit Rule' : 'New Rule'}
      detents={['large']}
      left={<BarButton text="Cancel" onClick={props.onClose} />}
      right={<BarButton text="Save" bold disabled={!valid} onClick={save} testId="rule-save" />}
      testId="rule-sheet"
    >
      <div class="cleanup-editor">
        <Section
          footer={
            regex
              ? 'A JavaScript regular expression, tested against each paragraph. Letter case is ignored.'
              : 'Hides every paragraph that contains this text. Letter case is ignored.'
          }
        >
          <label class="row cleanup-pattern-row">
            <input
              class={`filter-text${regex ? ' cleanup-code' : ''}`}
              type="text"
              value={pattern}
              placeholder={regex ? String.raw`^Read (?:at|on) \S+` : 'Text to hide, e.g. Read at'}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellcheck={false}
              enterKeyHint="done"
              aria-label="Text to hide"
              onInput={(e) => setPattern(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              data-testid="rule-pattern"
            />
          </label>
          <SwitchRow title="Regular expression" checked={regex} onChange={setRegex} testId="rule-regex" />
          <SelectRow title="Applies to" value={scope} options={scopeOptions} onChange={setScope} testId="rule-scope" />
        </Section>
        {error && (
          <p class="form-error cleanup-error" data-testid="rule-error">
            {error}
          </p>
        )}
        <RuleTester rule={valid ? draft : null} scope={scope} />
        {r && (
          <Section>
            <Row
              title="Delete Rule"
              destructive
              onClick={() => {
                props.onClose();
                props.onDelete(r);
              }}
              testId="rule-delete"
            />
          </Section>
        )}
      </div>
    </Sheet>
  );
}

// ---------- try it on a recent chapter ----------

function SweepResult(props: { rows: SweepRow[]; entries: readonly HistoryEntry[]; onOpen: (index: number) => void }) {
  const total = props.rows.reduce((a, r) => a + (r.hidden ?? 0), 0);
  const chapters = plural(props.rows.length, 'chapter');
  return (
    <Section
      header={total === 0 ? `Nothing would be hidden in ${chapters}` : `Would hide ${plural(total, 'paragraph')} across ${chapters}`}
      footer="Tap a chapter to see exactly what it hides."
    >
      {props.rows.map((r) => {
        const h = props.entries[r.index];
        if (!h) return null;
        return (
          <Row
            key={r.index}
            title={h.novelName}
            subtitle={h.chapterName}
            value={r.hidden === null ? 'Failed' : r.hidden === 0 ? 'None' : `${r.hidden} hidden`}
            chevron
            onClick={() => props.onOpen(r.index)}
            testId="rule-sweep-row"
          />
        );
      })}
    </Section>
  );
}

/** A rule hiding this many paragraphs of one chapter probably catches story text too. */
const BROAD_RULE_HITS = 4;

type TestState = { status: 'idle' } | { status: 'loading' } | { status: 'ok'; removed: string[]; rule: CleanupRule } | { status: 'error'; error: UiError };

/** Chapters the "recent chapters" sweep tests the rule on. */
const SWEEP_CHAPTERS = 5;

interface SweepRow {
  /** Index into the history list. */
  index: number;
  hidden: number | null;
  error?: string;
}

type SweepState = { status: 'idle' } | { status: 'loading'; done: number; total: number } | { status: 'ok'; rows: SweepRow[] };

function RuleTester(props: { rule: CleanupRule | null; scope: string }) {
  const history = useAsync(() => bridge().call('history.list', { limit: 30 }), []);
  const entries = history.data ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const [state, setState] = useState<TestState>({ status: 'idle' });
  const [sweep, setSweep] = useState<SweepState>({ status: 'idle' });
  const results = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const sweepSeq = useRef(0);
  const runAfterPick = useRef(false);

  const preferred = props.scope === '*' ? 0 : Math.max(0, entries.findIndex((h) => h.pluginId === props.scope));
  const index = pick !== null && entries[Number(pick)] ? Number(pick) : preferred;
  const chapter = entries[index];
  const outOfScope = chapter !== undefined && props.scope !== '*' && chapter.pluginId !== props.scope;
  const ruleKey = props.rule ? `${props.rule.pattern}\u0000${String(props.rule.regex)}\u0000${props.rule.scope}` : '';

  // Recent chapters the rule applies to (one per novel), for the sweep.
  const sweepTargets: number[] = [];
  const seen = new Set<string>();
  entries.forEach((h, i) => {
    const k = `${h.pluginId}:${h.path}`;
    if (sweepTargets.length < SWEEP_CHAPTERS && !seen.has(k) && (props.scope === '*' || h.pluginId === props.scope)) {
      seen.add(k);
      sweepTargets.push(i);
    }
  });

  // A different rule or chapter makes the last result stale.
  useEffect(() => {
    seq.current++;
    setState({ status: 'idle' });
    if (runAfterPick.current) {
      runAfterPick.current = false;
      void run();
    }
  }, [ruleKey, index]);

  useEffect(() => {
    sweepSeq.current++;
    setSweep({ status: 'idle' });
  }, [ruleKey]);

  // A new scope picks a chapter from that source again (an earlier manual pick may be out of scope).
  const firstScope = useRef(true);
  useEffect(() => {
    if (firstScope.current) firstScope.current = false;
    else setPick(null);
  }, [props.scope]);

  useEffect(() => {
    if (sweep.status === 'ok') sweepRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [sweep.status]);

  useEffect(() => {
    if (state.status === 'ok' || state.status === 'error') results.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [state.status]);

  async function runSweep(): Promise<void> {
    const rule = props.rule;
    if (!rule || sweepTargets.length === 0) return;
    const id = ++sweepSeq.current;
    const rows: SweepRow[] = [];
    setSweep({ status: 'loading', done: 0, total: sweepTargets.length });
    for (const i of sweepTargets) {
      const h = entries[i];
      if (!h) continue;
      try {
        const r = await bridge().call('cleanup.test', { rule, pluginId: h.pluginId, novelPath: h.path, chapterPath: h.chapterPath }, { timeoutMs: 60_000 });
        rows.push({ index: i, hidden: r.removed.length });
      } catch (err) {
        rows.push({ index: i, hidden: null, error: errorText(toUiError(err)) });
      }
      if (id !== sweepSeq.current) return;
      setSweep({ status: 'loading', done: rows.length, total: sweepTargets.length });
    }
    setSweep({ status: 'ok', rows });
  }

  /** Show one chapter of the sweep in detail. */
  function openSweepRow(i: number): void {
    if (i === index) void run();
    else {
      runAfterPick.current = true;
      setPick(String(i));
    }
  }

  async function run(): Promise<void> {
    const rule = props.rule;
    if (!rule || !chapter) return;
    const id = ++seq.current;
    setState({ status: 'loading' });
    try {
      const r = await bridge().call('cleanup.test', { rule, pluginId: chapter.pluginId, novelPath: chapter.path, chapterPath: chapter.chapterPath }, { timeoutMs: 60_000 });
      if (id === seq.current) setState({ status: 'ok', removed: r.removed, rule });
    } catch (err) {
      if (id === seq.current) setState({ status: 'error', error: toUiError(err) });
    }
  }

  return (
    <>
      <Section
        header="Try It"
        footer={
          outOfScope
            ? `This rule only applies to ${scopeName(props.scope)}, so it won’t hide anything in this chapter.`
            : 'Runs the rule on chapters you read recently. Nothing is changed.'
        }
      >
        {history.status === 'loading' && !history.data ? (
          <SkeletonRows count={1} height={48} />
        ) : history.status === 'error' && history.error && !history.data ? (
          <ErrorState error={history.error} onRetry={() => void history.reload()} compact />
        ) : entries.length === 0 ? (
          <Row title="No chapters in your history yet" disabled />
        ) : (
          <>
            <SelectRow
              title="Chapter"
              value={String(index)}
              options={entries.map((h, i) => ({ value: String(i), label: `${h.novelName} · ${h.chapterName}` }))}
              onChange={setPick}
              testId="rule-test-chapter"
            />
            <Row
              title={state.status === 'loading' ? 'Testing…' : 'Test Rule'}
              subtitle={props.rule ? undefined : 'Enter a valid pattern first'}
              tint
              disabled={!props.rule || state.status === 'loading'}
              onClick={() => void run()}
              testId="rule-test"
            />
            {sweepTargets.length > 1 && (
              <Row
                title={sweep.status === 'loading' ? `Testing ${sweep.done + 1} of ${sweep.total}…` : `Test on ${sweepTargets.length} Recent Chapters`}
                tint
                disabled={!props.rule || sweep.status === 'loading'}
                onClick={() => void runSweep()}
                testId="rule-sweep"
              />
            )}
          </>
        )}
      </Section>
      <div ref={sweepRef} data-testid="rule-sweep-result" data-status={sweep.status}>
        {sweep.status === 'ok' && <SweepResult rows={sweep.rows} entries={entries} onOpen={openSweepRow} />}
      </div>
      <div ref={results} data-testid="rule-test-result" data-status={state.status}>
        {state.status === 'ok' && (
          <Section
            header={state.removed.length === 0 ? 'Nothing would be hidden' : `Would hide ${plural(state.removed.length, 'paragraph')}`}
            {...(state.removed.length >= BROAD_RULE_HITS
              ? { footer: 'That’s a lot for one chapter. Check these are all junk and not part of the story, or make the pattern more specific.' }
              : {})}
          >
            {state.removed.length === 0 ? (
              <Row title="No paragraph in this chapter matches." disabled />
            ) : (
              state.removed.map((t, i) => (
                <div class="row cleanup-hit" key={i} data-testid="rule-hit">
                  <span class="cleanup-hit-text">
                    <Highlighted text={t} ranges={matchRanges(t, state.rule)} />
                  </span>
                </div>
              ))
            )}
          </Section>
        )}
        {state.status === 'error' && (
          <Section>
            <ErrorState error={state.error} onRetry={() => void run()} compact />
          </Section>
        )}
      </div>
    </>
  );
}
