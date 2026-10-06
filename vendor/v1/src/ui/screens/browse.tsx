/**
 * Browse: Sources | Extensions tabs, source languages (settings.languages, English by default), global
 * search entry (Tachimanga layout). The Extensions tab marks plugins the PC sweep verified and tucks
 * the ones it found broken into a collapsed section at the bottom.
 */
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AvailablePlugin, RepoInfo, SourceInfo } from '../../shared/contracts/domain.ts';
import { bridge, errorText, toUiError, type UiError } from '../bridge/client.ts';
import { BarButton, Button, Row, SearchField, Section, Segmented, Switch } from '../components/controls.tsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/feedback.tsx';
import { useAsync } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { Sheet } from '../components/sheet.tsx';
import { plural, relativeTime } from '../lib/format.ts';
import { attachLongPress, haptic } from '../lib/gestures.ts';
import { actionSheet, confirmAlert, openInSafari } from '../state/actions.ts';
import { push } from '../state/nav.ts';
import { reloadSources, settings, sources } from '../state/store.ts';
import { errorToast, showToast } from '../state/toast.ts';
import { GenresSheet } from './genre.tsx';
import { UnderlineTab } from './library.tsx';
import './browse.css';

// ---------- languages ----------

/**
 * Languages of the LNReader plugin index (plugins.min.json v3.0.0) as the index spells them — that
 * spelling is what settings.languages stores and the script filters `sources.available` by — with
 * their English names. (Arabic really starts with U+200E in the index.)
 */
const INDEX_LANGUAGES: readonly (readonly [index: string, english: string])[] = [
  ['English', 'English'],
  ['‎العربية', 'Arabic'],
  ['中文, 汉语, 漢語', 'Chinese'],
  ['Français', 'French'],
  ['Bahasa Indonesia', 'Indonesian'],
  ['日本語', 'Japanese'],
  ['조선말, 한국어', 'Korean'],
  ['Polski', 'Polish'],
  ['Português', 'Portuguese'],
  ['Русский', 'Russian'],
  ['Español', 'Spanish'],
  ['ไทย', 'Thai'],
  ['Türkçe', 'Turkish'],
  ['Українська', 'Ukrainian'],
  ['Tiếng Việt', 'Vietnamese'],
  ['Multi', 'Multiple languages'],
];

/** Drop the invisible direction marks some index names carry. */
function cleanLang(lang: string): string {
  return lang.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
}

const ENGLISH_NAMES = new Map(INDEX_LANGUAGES.map(([index, english]) => [cleanLang(index), english]));

const langNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    return null;
  }
})();

/** English name of a source language: an LNReader index name ("日本語" → "Japanese") or an ISO code ("ja"). */
export function languageName(lang: string): string {
  const l = cleanLang(lang);
  const known = ENGLISH_NAMES.get(l);
  if (known) return known;
  if (l === 'multi' || l === 'all') return 'Multiple languages';
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(l)) {
    try {
      return langNames?.of(l) ?? l.toUpperCase();
    } catch {
      return l.toUpperCase();
    }
  }
  return l || 'Unknown';
}

/** Whether a source in `lang` is shown for the selected languages (unknown languages always are). */
export function inLanguages(lang: string, languages: readonly string[]): boolean {
  const l = cleanLang(lang);
  if (languages.length === 0 || l === '' || l === 'Unknown') return true;
  return languages.some((x) => cleanLang(x) === l);
}

/** English first, then by English name. */
function compareLanguages(a: string, b: string): number {
  const x = languageName(a);
  const y = languageName(b);
  return x === 'English' ? (y === 'English' ? 0 : -1) : y === 'English' ? 1 : x.localeCompare(y);
}

/** Bumped after settings.languages is saved, so the Extensions catalog reloads with the new filter. */
const catalogVersion = signal(0);

/** Install a repo plugin; true on success (the error is shown as a toast otherwise). */
async function installPlugin(p: AvailablePlugin): Promise<boolean> {
  try {
    const s = await bridge().call('sources.install', { url: p.url }, { timeoutMs: 60_000 });
    sources.value = [...sources.value.filter((x) => x.id !== s.id), s];
    showToast(`Installed ${s.name}`);
    return true;
  } catch (err) {
    errorToast(errorText(toUiError(err)));
    return false;
  }
}

// ---------- source health ----------

export interface SourceHealth {
  ok: boolean;
  /** When this was last seen. */
  at: number;
  /** What went wrong (short text), when !ok. */
  error?: string;
}

/** How each source's latest request went this session (Latest and genre search report here). */
export const sourceHealth = signal<ReadonlyMap<string, SourceHealth>>(new Map());

/** Record a source request outcome. Being offline says nothing about the source, so it's ignored. */
export function recordSourceHealth(id: string, error?: UiError): void {
  if (error?.offline) return;
  const prev = sourceHealth.peek().get(id);
  if (!error && prev?.ok) return;
  const next = new Map(sourceHealth.peek());
  next.set(id, error ? { ok: false, at: Date.now(), error: errorText(error) } : { ok: true, at: Date.now() });
  sourceHealth.value = next;
}

export function SourceIcon({ source, size = 32 }: { source: Pick<SourceInfo, 'iconUrl' | 'name'>; size?: number }) {
  return (
    <span class="source-icon" style={{ width: `${size}px`, height: `${size}px` }}>
      {source.iconUrl ? <img src={source.iconUrl} alt="" loading="lazy" decoding="async" /> : <span class="source-letter">{source.name.charAt(0)}</span>}
    </span>
  );
}

/** Sources shown in Browse (and searched by genre search): enabled, in the selected languages. */
export function browsableSources(all: readonly SourceInfo[], languages: readonly string[]): SourceInfo[] {
  return all.filter((s) => s.enabled && inLanguages(s.lang, languages));
}

export function BrowseScreen() {
  const all = sources.value;
  const languages = settings.value.languages;
  const multi = languages.length > 1;
  const [tab, setTab] = useState<'sources' | 'extensions'>('sources');
  const [addOpen, setAddOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [genresOpen, setGenresOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => readFlag(GET_STARTED_KEY));
  const enabled = browsableSources(all, languages);
  /** First run: nothing but the built-in source(s) installed. */
  const showWelcome = !welcomeDismissed && all.every((s) => s.builtIn);
  const disabledCount = all.filter((s) => !s.enabled).length;
  const otherLangCount = all.filter((s) => s.enabled && !inLanguages(s.lang, languages)).length;

  const lastUsed = useMemo(() => [...enabled].filter((s) => s.lastUsedAt !== undefined && !s.pinned).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0], [all, languages]);
  const pinned = enabled.filter((s) => s.pinned);
  const rest = useMemo(() => {
    const list = enabled.filter((s) => !s.pinned && s !== lastUsed);
    return list.sort((a, b) => compareLanguages(a.lang, b.lang) || a.name.localeCompare(b.name));
  }, [all, languages, lastUsed]);

  const health = sourceHealth.value;
  const listRef = useRef<HTMLDivElement>(null);

  // Long-press a source row: Latest, Filters, Pin, Open in Safari (and why it last failed, if it did).
  // The root holds only source rows: every tap inside it starts on a row, which resets the helper's
  // "swallow the click after a long-press" flag (a native sheet eats the touch that would have).
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    return attachLongPress(root, '.src-row[data-source]', (el) => {
      const s = sources.peek().find((x) => x.id === el.dataset['source']);
      if (s) void sourceMenu(s);
    });
  }, [tab, enabled.length > 0]);

  async function sourceMenu(s: SourceInfo): Promise<void> {
    const h = sourceHealth.peek().get(s.id);
    const actions = [
      { title: 'Latest' },
      ...(s.hasFilters ? [{ title: 'Filters' }] : []),
      { title: s.pinned ? 'Unpin' : 'Pin' },
      { title: 'Open in Safari' },
    ];
    const i = await actionSheet({
      title: s.name,
      ...(h && !h.ok ? { message: `Last load failed ${relativeTime(h.at, Date.now()).toLowerCase()}: ${h.error ?? 'unknown error'}` } : {}),
      actions,
    });
    const t = actions[i]?.title;
    if (t === 'Latest') push({ name: 'source', pluginId: s.id, mode: 'latest' });
    else if (t === 'Filters') push({ name: 'source', pluginId: s.id, openFilters: true });
    else if (t === 'Pin' || t === 'Unpin') void togglePin(s);
    else if (t === 'Open in Safari') openInSafari(s.site);
  }

  async function togglePin(s: SourceInfo): Promise<void> {
    sources.value = sources.value.map((x) => (x.id === s.id ? { ...x, pinned: !s.pinned } : x));
    try {
      sources.value = await bridge().call('sources.setPinned', { id: s.id, pinned: !s.pinned });
    } catch {
      void reloadSources();
    }
  }

  const row = (s: SourceInfo) => (
    <div class="src-row" key={s.id} data-source={s.id}>
      <button
        type="button"
        class="src-main tap tap-row"
        onClick={() => push({ name: 'source', pluginId: s.id })}
        aria-label={health.get(s.id)?.ok === false ? `${s.name}, last load failed` : undefined}
        data-testid={`source-${s.id}`}
      >
        <span class="src-icon-wrap">
          <SourceIcon source={s} size={42} />
          {health.get(s.id)?.ok === false && <span class="health-dot" data-testid={`health-${s.id}`} />}
        </span>
        <span class="src-text">
          <span class="src-name ellipsis">{s.name}</span>
          {/* One language selected: every row would say the same thing. */}
          {multi && <span class="src-lang ellipsis">{languageName(s.lang)}</span>}
        </span>
      </button>
      {s.hasFilters && (
        <button type="button" class="src-action tap tap-dim" aria-label={`${s.name} filters`} onClick={() => push({ name: 'source', pluginId: s.id, openFilters: true })} data-testid={`filters-${s.id}`}>
          <Icon name="gearshape.fill" size={21} />
        </button>
      )}
      <button
        type="button"
        class={`src-action tap tap-dim${s.pinned ? ' is-on' : ''}`}
        aria-label={s.pinned ? `Unpin ${s.name}` : `Pin ${s.name}`}
        aria-pressed={s.pinned}
        onClick={() => void togglePin(s)}
        data-testid={`pin-${s.id}`}
      >
        <Icon name={s.pinned ? 'pin.fill' : 'pin'} size={21} />
      </button>
    </div>
  );

  const sourcesTab =
    enabled.length === 0 ? (
      <EmptyState
        icon="puzzlepiece.extension"
        title="No Sources"
        message={
          all.length > 0 && otherLangCount > 0
            ? `None of your enabled sources are in ${languages.map(languageName).join(' or ')}. Change Languages, or install sources from the Extensions tab.`
            : 'Install sources from the Extensions tab: add a plugin repository or paste a plugin.'
        }
        action={{ label: 'Open Extensions', onClick: () => setTab('extensions') }}
      />
    ) : (
      <div class="src-list" data-testid="source-list">
        {(enabled.length > 1 || enabled.some((s) => s.hasFilters)) && (
          <div class="discover-grid">
            {enabled.length > 1 && (
              <button type="button" class="discover-tile tap tap-scale" onClick={() => push({ name: 'latest' })} data-testid="browse-latest">
                <span class="discover-icon">
                  <Icon name="clock.arrow.circlepath" size={20} />
                </span>
                <span class="discover-text">
                  <span class="discover-title">Latest</span>
                  <span class="discover-sub">From all sources</span>
                </span>
              </button>
            )}
            {enabled.some((s) => s.hasFilters) && (
              <button type="button" class="discover-tile tap tap-scale" onClick={() => setGenresOpen(true)} data-testid="browse-genres">
                <span class="discover-icon">
                  <Icon name="square.grid.2x2.fill" size={19} />
                </span>
                <span class="discover-text">
                  <span class="discover-title">Genres</span>
                  <span class="discover-sub">Browse by genre</span>
                </span>
              </button>
            )}
          </div>
        )}
        <div ref={listRef}>
          {lastUsed && (
            <>
              <h3 class="list-header">Last used</h3>
              {row(lastUsed)}
            </>
          )}
          {pinned.length > 0 && (
            <>
              <h3 class="list-header">Pinned</h3>
              {pinned.map(row)}
            </>
          )}
          {rest.length > 0 && (lastUsed || pinned.length > 0) && <h3 class="list-header">All sources</h3>}
          {rest.map(row)}
        </div>
        {(disabledCount > 0 || otherLangCount > 0) && (
          <p class="list-footnote" data-testid="sources-footnote">
            {disabledCount > 0 && (
              <span class="footnote-line">
                {disabledCount} disabled {disabledCount === 1 ? 'source' : 'sources'} ·{' '}
                <button type="button" class="link-btn tap tap-dim" onClick={() => setTab('extensions')}>
                  Manage
                </button>
              </span>
            )}
            {otherLangCount > 0 && (
              <span class="footnote-line">
                {otherLangCount} in other languages ·{' '}
                <button type="button" class="link-btn tap tap-dim" onClick={() => setLangOpen(true)}>
                  Languages
                </button>
              </span>
            )}
          </p>
        )}
      </div>
    );

  return (
    <Screen
      title="Browse"
      large
      tab="browse"
      testId="screen-browse"
      right={
        <>
          <BarButton icon="magnifyingglass" label="Search all sources" onClick={() => push({ name: 'globalSearch' })} testId="global-search-button" />
          <BarButton icon="translate" label="Languages" onClick={() => setLangOpen(true)} testId="language-filter" />
          {tab === 'extensions' && <BarButton icon="plus" label="Add source" onClick={() => setAddOpen(true)} testId="add-source" />}
        </>
      }
      accessory={
        <div class="tabs-underline is-even" role="tablist">
          <div class="tabs-underline-inner">
            <UnderlineTab label="Sources" active={tab === 'sources'} onClick={() => setTab('sources')} testId="browse-tab-sources" />
            <UnderlineTab label="Extensions" active={tab === 'extensions'} onClick={() => setTab('extensions')} testId="browse-tab-extensions" />
          </div>
        </div>
      }
      onRefresh={reloadSources}
    >
      {tab === 'sources' && showWelcome && (
        <GetStartedCard
          onOpenExtensions={() => setTab('extensions')}
          onDismiss={() => {
            writeFlag(GET_STARTED_KEY);
            setWelcomeDismissed(true);
          }}
        />
      )}
      {tab === 'sources' ? sourcesTab : <ExtensionsPanel addOpen={addOpen} onAddOpenChange={setAddOpen} />}
      <LanguageSheet open={langOpen} onClose={() => setLangOpen(false)} />
      <GenresSheet open={genresOpen} onClose={() => setGenresOpen(false)} />
    </Screen>
  );
}

// ---------- first run ----------

const GET_STARTED_KEY = 'tachinovel.browse.getStarted.dismissed';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // Not persisted: the card comes back next launch, nothing else changes.
  }
}

/** First run: what Extensions are, plus a few verified sources to install right here. */
function GetStartedCard(props: { onOpenExtensions: () => void; onDismiss: () => void }) {
  const languages = settings.value.languages;
  const available = useAsync(() => bridge().call('sources.available', {}), [catalogVersion.value]);
  const [busy, setBusy] = useState<string | null>(null);
  const suggestions = (available.data ?? []).filter((p) => !p.installed && p.verified === 'works' && inLanguages(p.lang, languages)).slice(0, 3);

  async function get(p: AvailablePlugin): Promise<void> {
    setBusy(p.id);
    try {
      if (await installPlugin(p)) void available.reload({ silent: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="grouped get-started-wrap">
      <section class="group get-started" data-testid="get-started">
        <div class="group-body">
          <div class="get-started-head">
            <span class="get-started-icon">
              <Icon name="puzzlepiece.extension" size={22} />
            </span>
            <span class="get-started-copy">
              <span class="get-started-title">Add more sources</span>
              <span class="get-started-text">Sources are LNReader plugins from your repositories. These passed a full check in the latest sweep:</span>
            </span>
            <button type="button" class="sheet-close tap tap-dim" aria-label="Dismiss" onClick={props.onDismiss} data-testid="get-started-dismiss">
              <Icon name="xmark" size={13} />
            </button>
          </div>
          {available.status === 'loading' && !available.data ? (
            <SkeletonRows count={3} height={56} />
          ) : (
            suggestions.map((p) => (
              <Row
                key={p.id}
                class="ext-row"
                title={<ExtTitle name={p.name} verdict={p.verified} />}
                subtitle={`v${p.version}`}
                leading={<SourceIcon source={p} size={30} />}
                trailing={
                  <Button variant="tinted" size="small" onClick={() => void get(p)} disabled={busy === p.id}>
                    {busy === p.id ? 'Installing…' : 'Get'}
                  </Button>
                }
                testId={`suggest-${p.id}`}
              />
            ))
          )}
          <Row title="See All Extensions" tint chevron onClick={props.onOpenExtensions} testId="get-started-all" />
        </div>
      </section>
    </div>
  );
}

// ---------- languages sheet ----------

/** Plugins per language in the user's repos (cleaned name → { index spelling, count }), once loaded. */
const repoLanguages = signal<Map<string, { lang: string; count: number }> | null>(null);

async function loadRepoLanguages(): Promise<void> {
  try {
    const all = await bridge().call('sources.available', { allLanguages: true });
    const m = new Map<string, { lang: string; count: number }>();
    for (const p of all) {
      const k = cleanLang(p.lang);
      if (!k || k === 'Unknown') continue;
      const e = m.get(k);
      if (e) e.count++;
      else m.set(k, { lang: p.lang, count: 1 });
    }
    repoLanguages.value = m;
  } catch {
    // Keep the last list (or the built-in index list) on screen.
  }
}

/**
 * Every language in the user's repos (the built-in LNReader index list until they've loaded), plus
 * any installed source's, plus the current selection.
 */
function languageChoices(installed: readonly SourceInfo[], selected: readonly string[], repo: ReadonlyMap<string, { lang: string }> | null): string[] {
  const byKey = new Map<string, string>();
  const base = repo ? [...repo.values()].map((r) => r.lang) : INDEX_LANGUAGES.map(([index]) => index);
  for (const l of [...base, ...installed.map((s) => s.lang), ...selected]) {
    const k = cleanLang(l);
    if (k && k !== 'Unknown' && !byKey.has(k)) byKey.set(k, l);
  }
  return [...byKey.values()].sort(compareLanguages);
}

function LanguageSheet(props: { open: boolean; onClose: () => void }) {
  const current = settings.value.languages;
  const repo = repoLanguages.value;
  const [draft, setDraft] = useState<string[]>(current);
  // Fresh draft each time the sheet opens; the repo language list refreshes in the background.
  useEffect(() => {
    if (!props.open) return;
    setDraft(settings.peek().languages);
    void loadRepoLanguages();
  }, [props.open]);
  const choices = useMemo(() => languageChoices(sources.value, current, repo), [sources.value, current, repo]);
  const isOn = (l: string): boolean => draft.some((x) => cleanLang(x) === cleanLang(l));

  function toggle(l: string): void {
    if (isOn(l)) {
      if (draft.length === 1) {
        haptic(); // at least one language stays selected
        return;
      }
      setDraft(draft.filter((x) => cleanLang(x) !== cleanLang(l)));
    } else {
      setDraft([...draft, l]);
    }
  }

  async function save(): Promise<void> {
    props.onClose();
    const next = [...draft].sort(compareLanguages);
    const prev = settings.value.languages;
    if (next.length === prev.length && next.every((l) => prev.some((x) => cleanLang(x) === cleanLang(l)))) return;
    settings.value = { ...settings.value, languages: next };
    try {
      await bridge().call('settings.set', { patch: { languages: next } });
      catalogVersion.value++;
    } catch (err) {
      settings.value = { ...settings.value, languages: prev };
      errorToast(errorText(toUiError(err)));
    }
  }

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Languages"
      detents={['medium', 'large']}
      testId="language-sheet"
      left={<BarButton text="Cancel" onClick={props.onClose} testId="languages-cancel" />}
      right={<BarButton text="Save" bold onClick={() => void save()} testId="languages-save" />}
    >
      <div class="filters">
        <Section footer="Browse lists sources and extensions in these languages. At least one stays selected.">
          {choices.map((l) => {
            const on = isOn(l);
            const english = languageName(l);
            const native = cleanLang(l);
            const count = repo?.get(native)?.count;
            const sub = [native !== english ? native : '', count !== undefined ? `${count} ${count === 1 ? 'extension' : 'extensions'}` : ''].filter(Boolean).join(' · ');
            return (
              <button
                type="button"
                class={`row tap tap-row lang-row${on && draft.length === 1 ? ' is-last' : ''}`}
                key={native}
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggle(l)}
                data-testid={`lang-${english}`}
              >
                <span class="row-main">
                  <span class="row-title">{english}</span>
                  {sub && <span class="row-subtitle">{sub}</span>}
                </span>
                <span class={`row-check${on ? ' is-on' : ''}`}>
                  <Icon name="checkmark" size={17} />
                </span>
              </button>
            );
          })}
        </Section>
      </div>
    </Sheet>
  );
}

// ---------- extensions ----------

const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Search within extensions: name, id or site, ignoring case, spaces and punctuation ("royal road" finds Royal Road). */
export function extensionMatches(p: { id: string; name: string; site: string }, query: string): boolean {
  const q = squash(query);
  return q === '' || squash(p.name).includes(q) || squash(p.id).includes(q) || squash(p.site.replace(/^https?:\/\/(www\.)?/i, '')).includes(q);
}

type Verdict = AvailablePlugin['verified'];

/** "Verified" (sweep passed), muted "Partial", or (installed only) "Broken"; nothing when unverified. */
function VerdictBadge({ verdict }: { verdict: Verdict }) {
  if (verdict === 'works') {
    return (
      <span class="ext-badge is-works" data-testid="badge-verified">
        <Icon name="checkmark" size={9} />
        Verified
      </span>
    );
  }
  if (verdict === 'partial') {
    return (
      <span class="ext-badge is-partial" data-testid="badge-partial">
        Partial
      </span>
    );
  }
  if (verdict === 'broken') {
    return (
      <span class="ext-badge is-broken" data-testid="badge-broken">
        Broken
      </span>
    );
  }
  return null;
}

function ExtTitle({ name, verdict, pinned }: { name: string; verdict: Verdict; pinned?: boolean }) {
  return (
    <>
      <span class="ext-name ellipsis">{name}</span>
      {pinned && <Icon name="pin.fill" size={12} class="row-inline-icon ext-pin" />}
      <VerdictBadge verdict={verdict} />
    </>
  );
}

/**
 * Installed sources, repositories and the installable catalog. Browse › Extensions; the same props as
 * More › Extensions' panel so it can replace it there.
 */
export function ExtensionsPanel(props: { addOpen: boolean; onAddOpenChange: (open: boolean) => void }) {
  const languages = settings.value.languages;
  const multi = languages.length > 1;
  const installed = sources.value;
  const version = catalogVersion.value;
  const repos = useAsync(() => bridge().call('repos.list'), []);
  const available = useAsync(() => bridge().call('sources.available', {}), [version]);
  const [repoOpen, setRepoOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [brokenOpen, setBrokenOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim();
  const shown = (x: { id: string; name: string; site: string }): boolean => q === '' || extensionMatches(x, q);
  const updatable = installed.filter((s) => s.updateAvailable);

  const verdicts = useMemo(() => new Map((available.data ?? []).map((p) => [p.id, p.verified])), [available.data]);
  /** Language in a subtitle only when it tells something: several selected, or outside the selection. */
  const langPart = (lang: string): string => (multi || !inLanguages(lang, languages) ? ` · ${languageName(lang)}` : '');

  async function setEnabled(s: SourceInfo, enabled: boolean): Promise<void> {
    sources.value = sources.value.map((x) => (x.id === s.id ? { ...x, enabled } : x));
    try {
      sources.value = await bridge().call('sources.setEnabled', { id: s.id, enabled });
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    }
  }

  async function update(s: SourceInfo): Promise<void> {
    setBusy(s.id);
    try {
      const u = await bridge().call('sources.update', { id: s.id }, { timeoutMs: 60_000 });
      sources.value = sources.value.map((x) => (x.id === u.id ? u : x));
      showToast(`${s.name} updated to v${u.version}`);
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    } finally {
      setBusy(null);
    }
  }

  /** Updates every source with a newer version, one at a time. */
  async function updateAll(): Promise<void> {
    const list = updatable;
    const failed: string[] = [];
    for (const [i, s] of list.entries()) {
      setBulk({ done: i, total: list.length });
      setBusy(s.id);
      try {
        const u = await bridge().call('sources.update', { id: s.id }, { timeoutMs: 60_000 });
        sources.value = sources.value.map((x) => (x.id === u.id ? u : x));
      } catch {
        failed.push(s.name);
      }
    }
    setBusy(null);
    setBulk(null);
    if (failed.length === 0) showToast(`Updated ${plural(list.length, 'extension')}`);
    else errorToast(`Couldn’t update ${failed.join(', ')}`);
  }

  async function sourceMenu(s: SourceInfo): Promise<void> {
    const actions = [
      { title: s.pinned ? 'Unpin' : 'Pin to Top' },
      ...(s.updateAvailable ? [{ title: `Update to v${s.updateAvailable}` }] : []),
      { title: 'Open Website' },
      ...(s.builtIn ? [] : [{ title: 'Uninstall', destructive: true }]),
    ];
    const i = await actionSheet({ title: s.name, message: `v${s.version} · ${languageName(s.lang)}`, actions });
    const t = actions[i]?.title ?? '';
    if (t === 'Unpin' || t === 'Pin to Top') {
      try {
        sources.value = await bridge().call('sources.setPinned', { id: s.id, pinned: !s.pinned });
      } catch (err) {
        errorToast(errorText(toUiError(err)));
      }
    } else if (t.startsWith('Update')) void update(s);
    else if (t === 'Open Website') openInSafari(s.site);
    else if (t === 'Uninstall') {
      if (!(await confirmAlert(`Uninstall ${s.name}?`, 'Novels from this source stay in your library but can’t be updated.', 'Uninstall'))) return;
      try {
        sources.value = await bridge().call('sources.uninstall', { id: s.id });
        void available.reload({ silent: true });
      } catch (err) {
        errorToast(errorText(toUiError(err)));
      }
    }
  }

  async function install(p: AvailablePlugin): Promise<void> {
    setBusy(p.id);
    try {
      if (await installPlugin(p)) void available.reload({ silent: true });
    } finally {
      setBusy(null);
    }
  }

  async function repoMenu(r: RepoInfo): Promise<void> {
    const i = await actionSheet({ title: r.name, message: r.url, actions: [{ title: 'Remove Repository', destructive: true }] });
    if (i !== 0) return;
    try {
      repos.setData(() => undefined);
      await bridge().call('repos.remove', { url: r.url });
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    } finally {
      void repos.reload({ silent: true });
      void available.reload({ silent: true });
    }
  }

  // The script already filters by language; filtering here too hides a removed language at once.
  const notInstalled = (available.data ?? []).filter((p) => !p.installed && inLanguages(p.lang, languages) && shown(p));
  const installedShown = installed.filter(shown);
  const working = notInstalled.filter((p) => p.verified !== 'broken');
  const broken = notInstalled.filter((p) => p.verified === 'broken');
  const groups = useMemo(() => {
    if (!multi || working.length === 0) return [{ lang: '', items: working }];
    const byLang = new Map<string, AvailablePlugin[]>();
    for (const p of working) {
      const k = cleanLang(p.lang);
      byLang.set(k, [...(byLang.get(k) ?? []), p]);
    }
    return [...byLang.entries()].sort(([a], [b]) => compareLanguages(a, b)).map(([lang, items]) => ({ lang, items }));
  }, [available.data, languages, q]);

  const availableRow = (p: AvailablePlugin) => (
    <Row
      key={p.id}
      class={`ext-row${p.verified === 'broken' ? ' is-broken' : ''}`}
      title={<ExtTitle name={p.name} verdict={p.verified === 'broken' ? undefined : p.verified} />}
      subtitle={`v${p.version}${langPart(p.lang)}`}
      leading={<SourceIcon source={p} size={30} />}
      trailing={
        <Button variant={p.verified === 'broken' ? 'gray' : 'tinted'} size="small" onClick={() => void install(p)} disabled={busy === p.id}>
          {busy === p.id ? 'Installing…' : 'Get'}
        </Button>
      }
      testId={`available-${p.id}`}
    />
  );

  const loadingCatalog = available.status === 'loading' && !available.data;
  // A search shows matching broken plugins too.
  const brokenShown = brokenOpen || q !== '';
  const catalogError = available.status === 'error' && available.error && !available.data ? available.error : null;

  return (
    <>
      <div class="grouped" data-testid="extensions-panel">
        <div class="ext-search">
          <SearchField value={query} onInput={setQuery} onSubmit={setQuery} onCancel={() => setQuery('')} placeholder="Search extensions" testId="ext-search" />
        </div>

        {q !== '' && installedShown.length === 0 && notInstalled.length === 0 && !loadingCatalog && (
          <EmptyState icon="magnifyingglass" title="No Matches" message={`No installed or available extension matches “${q}”.`} testId="ext-no-match" />
        )}

        {installedShown.length > 0 && (
          <Section
            header={
              <span class="ext-header-row">
                <span>Installed</span>
                {updatable.length > 0 && q === '' && (
                  <button type="button" class="link-btn tap tap-dim ext-update-all" onClick={() => void updateAll()} disabled={bulk !== null || busy !== null} data-testid="ext-update-all">
                    {bulk ? `Updating ${bulk.done + 1} of ${bulk.total}…` : updatable.length > 1 ? `Update All (${updatable.length})` : 'Update All'}
                  </button>
                )}
              </span>
            }
            {...(q === '' ? { footer: 'Only install sources from repositories you trust: plugins run inside the app.' } : {})}
          >
            {installedShown.map((s) => (
              <div class="row source-manage-row ext-row" key={s.id} data-testid={`installed-${s.id}`}>
                <button type="button" class="source-manage-main tap tap-dim" onClick={() => void sourceMenu(s)}>
                  <SourceIcon source={s} size={30} />
                  <span class="row-main">
                    <span class="row-title">
                      <ExtTitle name={s.name} verdict={verdicts.get(s.id)} pinned={s.pinned} />
                    </span>
                    <span class="row-subtitle">
                      v{s.version}
                      {langPart(s.lang)}
                      {s.builtIn ? ' · Built in' : ''}
                    </span>
                  </span>
                </button>
                {s.updateAvailable && (
                  <Button variant="tinted" size="small" onClick={() => void update(s)} disabled={busy === s.id || bulk !== null}>
                    {busy === s.id ? 'Updating…' : 'Update'}
                  </Button>
                )}
                <Switch checked={s.enabled} onChange={(v) => void setEnabled(s, v)} label={`Enable ${s.name}`} />
              </div>
            ))}
          </Section>
        )}

        {q === '' && (
          <Section header="Repositories">
            {repos.status === 'loading' && !repos.data ? (
              <SkeletonRows count={1} height={52} />
            ) : (
              (repos.data ?? []).map((r) => <Row key={r.url} title={r.name} subtitle={`${r.pluginCount} plugins`} chevron onClick={() => void repoMenu(r)} />)
            )}
            <Row title="Add Repository…" tint onClick={() => setRepoOpen(true)} testId="add-repo" />
          </Section>
        )}

        {loadingCatalog ? (
          <Section header="Available">
            <SkeletonRows count={4} height={56} />
          </Section>
        ) : catalogError ? (
          <Section header="Available">
            <ErrorState error={catalogError} onRetry={() => void available.reload()} compact />
          </Section>
        ) : (
          groups
            .filter((g) => q === '' || g.items.length > 0)
            .map((g, i, all) => (
              <Section
                key={g.lang || 'all'}
                header={g.lang ? `Available in ${languageName(g.lang)}` : 'Available'}
                {...(i === all.length - 1 && q === '' ? { footer: 'From your repositories. “Verified” plugins passed a full check: browse, search, novel page and a chapter.' } : {})}
              >
                {g.items.length === 0 ? <Row title="Everything is installed" disabled /> : g.items.map(availableRow)}
              </Section>
            ))
        )}

        {broken.length > 0 && (
          <section class="group ext-broken" data-testid="ext-broken">
            <div class="group-body">
              <button type="button" class="row tap tap-row" aria-expanded={brokenShown} onClick={() => setBrokenOpen(!brokenOpen)} data-testid="ext-broken-toggle">
                <Icon name="exclamationmark.triangle" size={20} class="row-leading-icon ext-broken-icon" />
                <span class="row-main">
                  <span class="row-title">Probably broken</span>
                </span>
                <span class="row-value tabular">{broken.length}</span>
                <Icon name="chevron.right" size={14} class={`row-chevron ext-disclosure${brokenShown ? ' is-open' : ''}`} />
              </button>
              {brokenShown && broken.map(availableRow)}
            </div>
            {brokenShown && <p class="group-footer">These failed the latest automated check, so they probably won’t load. Sites change: one may work again after a plugin update.</p>}
          </section>
        )}
      </div>
      <AddSourceSheet open={props.addOpen} onClose={() => props.onAddOpenChange(false)} onInstalled={() => void available.reload({ silent: true })} />
      <AddRepoSheet
        open={repoOpen}
        onClose={() => setRepoOpen(false)}
        onAdded={(r) => {
          repos.setData(() => r);
          void available.reload({ silent: true });
        }}
      />
    </>
  );
}

function AddSourceSheet(props: { open: boolean; onClose: () => void; onInstalled: () => void }) {
  const [mode, setMode] = useState<'url' | 'code'>('url');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function install(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const s = await bridge().call('sources.install', mode === 'url' ? { url: url.trim() } : { code }, { timeoutMs: 60_000 });
      sources.value = [...sources.value.filter((x) => x.id !== s.id), s];
      showToast(`Installed ${s.name}`);
      setUrl('');
      setCode('');
      props.onInstalled();
      props.onClose();
    } catch (err) {
      setError(toUiError(err).message);
    } finally {
      setBusy(false);
    }
  }

  const ready = mode === 'url' ? /^https:\/\/\S+$/i.test(url.trim()) : code.trim().length > 20;
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Add Source" detents={['fit']} testId="add-source-sheet">
      <div class="sheet-pad add-source">
        <Segmented
          options={[
            { value: 'url', label: 'From URL' },
            { value: 'code', label: 'Paste Code' },
          ]}
          value={mode}
          onChange={setMode}
        />
        {mode === 'url' ? (
          <input
            class="text-input"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://…/plugin.js"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
            data-testid="source-url"
          />
        ) : (
          <textarea class="text-input code-input" placeholder="Paste an LNReader plugin (CommonJS)…" value={code} onInput={(e) => setCode(e.currentTarget.value)} spellcheck={false} data-testid="source-code" />
        )}
        {error && <p class="form-error">{error}</p>}
        <p class="form-note">Plugins use LNReader’s format. Only add plugins you trust.</p>
        <Button variant="filled" size="large" onClick={() => void install()} disabled={!ready || busy}>
          {busy ? 'Installing…' : 'Install'}
        </Button>
      </div>
    </Sheet>
  );
}

function AddRepoSheet(props: { open: boolean; onClose: () => void; onAdded: (r: RepoInfo[]) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function add(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      props.onAdded(await bridge().call('repos.add', { url: url.trim() }, { timeoutMs: 60_000 }));
      setUrl('');
      props.onClose();
    } catch (err) {
      setError(toUiError(err).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Add Repository" detents={['fit']}>
      <div class="sheet-pad add-source">
        <input class="text-input" type="url" inputMode="url" autoComplete="off" placeholder="https://…/plugins.min.json" value={url} onInput={(e) => setUrl(e.currentTarget.value)} data-testid="repo-url" />
        {error && <p class="form-error">{error}</p>}
        <p class="form-note">A repository is an index file listing plugins, like LNReader’s plugins.min.json.</p>
        <Button variant="filled" size="large" onClick={() => void add()} disabled={!/^https:\/\/\S+$/i.test(url.trim()) || busy}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </Sheet>
  );
}
