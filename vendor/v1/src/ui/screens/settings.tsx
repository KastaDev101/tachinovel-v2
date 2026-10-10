/** Settings pages pushed from More: appearance, reader, library, categories, storage, sources, about. */
import { useEffect, useState } from 'preact/hooks';
import type { AppSettings, Category, StorageCategory, StorageUsage } from '../../shared/contracts/domain.ts';
import type { BackupPreview } from '../../shared/contracts/protocol.ts';
import { bridge, errorText, toUiError } from '../bridge/client.ts';
import { BarButton, Button, CheckRow, Row, Section, Segmented, SelectRow, Stepper, SwitchRow } from '../components/controls.tsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/feedback.tsx';
import { useAsync } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { ReorderList } from '../components/reorder-list.tsx';
import { Sheet } from '../components/sheet.tsx';
import { formatBytes, plural } from '../lib/format.ts';
import { actionSheet, confirmAlert, openInSafari } from '../state/actions.ts';
import { push, type SettingsPage } from '../state/nav.ts';
import { buildVersion, categories, patchSettings, reloadLibrary, settings, sortedCategories } from '../state/store.ts';
import { errorToast, showToast } from '../state/toast.ts';
import { ExtensionsPanel } from './browse.tsx';
import { ReaderSettingsPanel } from './reader/reader-settings.tsx';
import { exportLibraryList, RestoreSheet } from './backup-restore.tsx';
import { AutoBackupSection, AutoDownloadSection } from './settings-auto.tsx';
import { CleanupPage } from './settings-cleanup.tsx';
import { whatsNewOpen } from './whats-new.tsx';

export function SettingsScreen({ page }: { page: SettingsPage }) {
  switch (page) {
    case 'general':
      return <GeneralPage />;
    case 'downloads':
      return <DownloadsPage />;
    case 'backup':
      return <BackupPage />;
    case 'appearance':
      return <AppearancePage />;
    case 'reader':
      return <ReaderPage />;
    case 'library':
      return <LibraryPage />;
    case 'categories':
      return <CategoriesPage />;
    case 'storage':
      return <StoragePage />;
    case 'sources':
      return <SourcesPage />;
    case 'about':
      return <AboutPage />;
    case 'licenses':
      return <LicensesPage />;
    case 'developer':
      return __DEV_BUILD__ ? <DeveloperPage /> : <AboutPage />;
    case 'cleanup':
      return <CleanupPage />;
  }
}

// ---------- general / downloads / backup ----------

/** "Version 2.0.0 (abc1234)": the build hash once, even when the version string already carries it. */
export function aboutVersion(version: string, hash: string): string {
  return version.includes(hash) ? `Version ${version}` : `Version ${version} (${hash})`;
}

function GeneralPage() {
  const s = settings.value;
  return (
    <Screen class="is-grouped" title="General" back="More" testId="screen-general">
      <div class="grouped">
        <Section footer="Pauses reading history while on. Your progress in each novel is still saved.">
          <SwitchRow title="Incognito mode" checked={s.incognito} onChange={(incognito) => patchSettings({ incognito })} testId="incognito" />
        </Section>
      </div>
    </Screen>
  );
}

function DownloadsPage() {
  const s = settings.value;
  const usage = useAsync(() => bridge().call('storage.usage'), []);
  const bytes = usage.data?.bytes.downloads ?? 0;
  async function clear(): Promise<void> {
    if (!(await confirmAlert('Delete all downloads?', 'Downloaded chapters will be removed from this iPhone. Your reading progress is kept.', 'Delete'))) return;
    try {
      const u = await bridge().call('storage.clear', { category: 'downloads' });
      usage.setData(() => u);
      showToast('Downloads deleted');
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    }
  }
  return (
    <Screen class="is-grouped" title="Downloads" back="More" testId="screen-downloads">
      <div class="grouped">
        <Section footer="Chapters stream while you read. To read offline, download chapters from a novel’s page, or turn on Auto-download below.">
          <Row title="Downloaded chapters" value={usage.data ? formatBytes(bytes) : '…'} />
          <SwitchRow title="Delete after reading" checked={s.deleteDownloadsAfterRead} onChange={(deleteDownloadsAfterRead) => patchSettings({ deleteDownloadsAfterRead })} />
        </Section>
        <AutoDownloadSection />
        {bytes > 0 && (
          <Section>
            <Row title="Delete All Downloads" destructive onClick={() => void clear()} testId="delete-downloads" />
          </Section>
        )}
      </div>
    </Screen>
  );
}

const fmtBackupDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function BackupPage() {
  const list = useAsync(() => bridge().call('backup.list'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<{ n: number; open: boolean; preview: BackupPreview | null }>({ n: 0, open: false, preview: null });

  function share(fileName: string): void {
    void bridge()
      .call('backup.share', { fileName })
      .catch((err: unknown) => errorToast(errorText(toUiError(err))));
  }

  async function create(): Promise<void> {
    setBusy('create');
    try {
      const b = await bridge().call('backup.create', undefined, { timeoutMs: 120_000 });
      list.setData((l) => [b, ...(l ?? []).filter((x) => x.fileName !== b.fileName)]);
      showToast('Backup created', { undo: () => share(b.fileName), actionLabel: 'Share', durationMs: 5000 });
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    } finally {
      setBusy(null);
    }
  }

  /** Restore, step 1: read the backup (a listed one, or one picked in Files) and show what it holds. */
  async function restore(fileName?: string): Promise<void> {
    setBusy(fileName ?? 'files');
    try {
      const preview = await bridge().call('backup.preview', fileName ? { fileName } : {}, { timeoutMs: 300_000 });
      setRestoring((r) => ({ n: r.n + 1, open: true, preview }));
    } catch (err) {
      const ui = toUiError(err);
      // Cancelling the file picker isn't an error.
      if (fileName === undefined && ui.code === 'NOT_FOUND') return;
      errorToast(ui.code === 'INVALID_ARGS' ? `That file can’t be restored: ${errorText(ui)}` : errorText(ui));
    } finally {
      setBusy(null);
    }
  }

  async function rowMenu(fileName: string): Promise<void> {
    const i = await actionSheet({ title: fileName, actions: [{ title: 'Restore…' }, { title: 'Share' }] });
    if (i === 0) void restore(fileName);
    else if (i === 1) share(fileName);
  }

  const backups = list.data ?? [];
  return (
    <Screen class="is-grouped" title="Backup & Restore" back="More" testId="screen-backup" onRefresh={() => list.reload({ silent: true })}>
      <div class="grouped">
        <Section footer="A backup holds your library, categories, reading progress, history, settings and installed sources. Backups are saved in iCloud Drive › Scriptable › TachiNovel › backups.">
          <Row title={busy === 'create' ? 'Creating Backup…' : 'Create Backup'} tint disabled={busy !== null} onClick={() => void create()} testId="backup-create" />
          <Row title={busy === 'files' ? 'Reading Backup…' : 'Restore from Files…'} tint disabled={busy !== null} onClick={() => void restore()} testId="backup-restore-files" />
        </Section>
        <AutoBackupSection />
        <Section footer="A list of your novels to keep or share: a spreadsheet (CSV) or plain text. It isn’t a backup and can’t be restored.">
          <Row
            title={busy === 'export' ? 'Exporting…' : 'Export Library List…'}
            tint
            disabled={busy !== null}
            onClick={() => {
              setBusy('export');
              void exportLibraryList().finally(() => setBusy(null));
            }}
            testId="library-export"
          />
        </Section>
        <Section header="Backups">
          {list.status === 'loading' && !list.data ? (
            <SkeletonRows count={2} height={56} />
          ) : list.status === 'error' && list.error && !list.data ? (
            <ErrorState error={list.error} onRetry={() => void list.reload()} compact />
          ) : backups.length === 0 ? (
            <Row title="No backups yet" disabled />
          ) : (
            backups.map((b) => (
              <Row
                key={b.fileName}
                title={fmtBackupDate.format(b.createdAt)}
                subtitle={`${formatBytes(b.bytes)} · ${b.fileName}`}
                leading={<Icon name="doc.text" size={22} class="row-leading-icon" />}
                value={busy === b.fileName ? 'Reading…' : undefined}
                chevron
                onClick={() => void rowMenu(b.fileName)}
                testId="backup-row"
              />
            ))
          )}
        </Section>
      </div>
      {restoring.preview && (
        <RestoreSheet
          key={restoring.n}
          open={restoring.open}
          preview={restoring.preview}
          onClose={() => setRestoring((r) => ({ ...r, open: false }))}
          onPickAgain={() => {
            setRestoring((r) => ({ ...r, open: false }));
            void restore();
          }}
        />
      )}
    </Screen>
  );
}

// ---------- appearance ----------

function AppearancePage() {
  const a = settings.value.appearance;
  const opts: { value: AppSettings['appearance']; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
  return (
    <Screen class="is-grouped" title="Appearance" back="More" testId="screen-appearance">
      <div class="grouped">
        <div class="appearance-cards" role="radiogroup" aria-label="Appearance">
          {opts.map((o) => (
            <button type="button" role="radio" aria-checked={a === o.value} class={`appearance-card tap tap-scale${a === o.value ? ' is-selected' : ''}`} key={o.value} onClick={() => patchSettings({ appearance: o.value })} data-testid={`appearance-${o.value}`}>
              <span class={`appearance-preview is-${o.value}`}>
                <span />
                <span />
                <span />
              </span>
              <span class="appearance-label">{o.label}</span>
              <Icon name={a === o.value ? 'checkmark.circle.fill' : 'circle'} size={22} class="appearance-check" />
            </button>
          ))}
        </div>
        <p class="group-footer">“System” follows the iPhone’s Light/Dark setting. The reader has its own themes in Reader settings.</p>
      </div>
    </Screen>
  );
}

// ---------- reader ----------

function ReaderPage() {
  const s = settings.value;
  const r = s.reader;
  return (
    <Screen class="is-grouped" title="Reader" back="More" testId="screen-reader-settings">
      <div class={`reader-preview theme-${r.theme}`} style={{ '--rd-size': `${r.fontSize}px`, '--rd-lh': String(r.lineHeight), '--rd-margin': `${Math.min(r.margin, 28)}px` }}>
        <p style={{ fontFamily: fontFor(r.font), textAlign: r.justify ? 'justify' : 'start', textIndent: r.indent ? '1.6em' : '0' }}>
          The lantern swung once in the wind, and the narrow street below the old lighthouse fell quiet. Somewhere beyond the river road, a bell rang and was still.
        </p>
      </div>
      <div class="grouped">
        <ReaderSettingsPanel showBrightness={false} />
        <Section header="Reading">
          <SelectRow
            title="Mark chapter read at"
            value={String(r.markReadAt)}
            options={[
              { value: '0.9', label: '90%' },
              { value: '0.95', label: '95%' },
              { value: '1', label: 'End of chapter' },
            ]}
            onChange={(v) => patchSettings({ reader: { markReadAt: Number(v) } })}
          />
          <SelectRow
            title="Read ahead"
            value={String(s.readAhead)}
            options={[
              { value: '0', label: 'Off' },
              { value: '1', label: '1 chapter' },
              { value: '2', label: '2 chapters' },
              { value: '3', label: '3 chapters' },
            ]}
            onChange={(v) => patchSettings({ readAhead: Number(v) })}
          />
        </Section>
        <Section footer="Hide junk paragraphs like “Read at …” notices and translator credits.">
          <Row
            title="Text cleanup"
            value={s.cleanupRules.some((c) => c.enabled) ? plural(s.cleanupRules.filter((c) => c.enabled).length, 'rule') : 'Off'}
            chevron
            onClick={() => push({ name: 'settings', page: 'cleanup' })}
            testId="reader-cleanup"
          />
        </Section>
      </div>
    </Screen>
  );
}

function fontFor(f: string): string {
  switch (f) {
    case 'sans':
      return '-apple-system, system-ui, sans-serif';
    case 'rounded':
      return 'ui-rounded, -apple-system, system-ui, sans-serif';
    case 'georgia':
      return 'Georgia, serif';
    default:
      return 'ui-serif, "New York", Georgia, serif';
  }
}

// ---------- library ----------

function LibraryPage() {
  const lib = settings.value.library;
  return (
    <Screen class="is-grouped" title="Library" back="More" testId="screen-library-settings">
      <div class="grouped">
        <Section header="Display">
          <div class="row">
            <Segmented
              class="row-segmented"
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
                { value: 'list', label: 'List' },
              ]}
              value={lib.display}
              onChange={(display) => patchSettings({ library: { display } })}
            />
          </div>
          <div class="row">
            <span class="row-main">
              <span class="row-title">Grid columns</span>
            </span>
            <Stepper label="Grid columns" value={lib.columns} min={2} max={5} step={1} onChange={(columns) => patchSettings({ library: { columns } })} />
          </div>
          <SwitchRow title="Unread badges" checked={lib.showUnreadBadge} onChange={(showUnreadBadge) => patchSettings({ library: { showUnreadBadge } })} />
          <SwitchRow title="Downloaded badges" checked={lib.showDownloadBadge} onChange={(showDownloadBadge) => patchSettings({ library: { showDownloadBadge } })} />
        </Section>
        <Section header="Updates" footer="Updates are checked while the app is open, a few novels at a time.">
          <SwitchRow title="Check for updates on launch" checked={lib.updateOnOpen} onChange={(updateOnOpen) => patchSettings({ library: { updateOnOpen } })} />
        </Section>
        <Section
          header="Categories"
          footer={
            lib.addTo === 'ask'
              ? 'Adding a novel opens the category picker, with your last choice already checked.'
              : 'One tap adds a novel; the toast’s “Change” or a long-press on “Add to Library” picks other categories.'
          }
        >
          <Row title="Categories" value={String(categories.value.length)} chevron onClick={() => push({ name: 'settings', page: 'categories' })} />
          <SelectRow
            title="Add new novels to"
            value={lib.addTo === 'last' || lib.addTo === 'ask' || sortedCategories.value.some((c) => c.id === lib.addTo) ? lib.addTo : 'last'}
            options={[
              { value: 'last', label: 'Last used' },
              { value: 'ask', label: 'Ask every time' },
              ...sortedCategories.value.map((c) => ({ value: c.id, label: c.name })),
            ]}
            onChange={(addTo) => patchSettings({ library: { addTo } })}
            testId="library-add-to"
          />
        </Section>
      </div>
    </Screen>
  );
}

// ---------- categories ----------

function CategoriesPage() {
  const list = sortedCategories.value;
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [name, setName] = useState('');

  async function save(next: Category[]): Promise<void> {
    const ordered = next.map((c, i) => ({ ...c, order: i }));
    categories.value = ordered;
    try {
      categories.value = await bridge().call('categories.save', { categories: ordered });
      void reloadLibrary();
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    }
  }

  function startEdit(c: Category | 'new'): void {
    setEditing(c);
    setName(c === 'new' ? '' : c.name);
  }

  function commit(): void {
    const n = name.trim();
    if (!n) return;
    if (list.some((c) => c.name.toLowerCase() === n.toLowerCase() && (editing === 'new' || c.id !== editing?.id))) {
      showToast('A category with that name already exists');
      return;
    }
    if (editing === 'new') void save([...list, { id: `c${Date.now().toString(36)}`, name: n, order: list.length }]);
    else if (editing) void save(list.map((c) => (c.id === editing.id ? { ...c, name: n } : c)));
    setEditing(null);
  }

  async function menu(c: Category, i: number): Promise<void> {
    const actions = [{ title: 'Rename' }, ...(i > 0 ? [{ title: 'Move Up' }] : []), ...(i < list.length - 1 ? [{ title: 'Move Down' }] : []), { title: 'Delete', destructive: true }];
    const k = await actionSheet({ title: c.name, actions });
    const t = actions[k]?.title;
    if (t === 'Rename') startEdit(c);
    else if (t === 'Move Up' || t === 'Move Down') {
      const next = [...list];
      const j = t === 'Move Up' ? i - 1 : i + 1;
      [next[i], next[j]] = [next[j] as Category, next[i] as Category];
      void save(next);
    } else if (t === 'Delete') {
      if (await confirmAlert(`Delete “${c.name}”?`, 'Novels in this category stay in your library.', 'Delete')) void save(list.filter((x) => x.id !== c.id));
    }
  }

  return (
    <Screen class="is-grouped" title="Categories" back="More" right={<BarButton icon="plus" label="Add category" onClick={() => startEdit('new')} testId="add-category" />} testId="screen-categories">
      <div class="grouped">
        {list.length === 0 ? (
          <EmptyState icon="folder" title="No Categories" message="Group your library into tabs like “Reading” or “Plan to Read”." action={{ label: 'Add Category', onClick: () => startEdit('new') }} />
        ) : (
          <Section footer="Drag ≡ to reorder; the library's tabs follow. Tap a category to rename or delete it.">
            <ReorderList
              items={list}
              keyOf={(c) => c.id}
              gripLabel={(c) => `Reorder ${c.name}`}
              onReorder={(next) => void save(next)}
              testId="category-list"
              render={(c, i) => <Row title={c.name} leading={<Icon name="folder" size={20} class="row-leading-icon" />} onClick={() => void menu(c, i)} />}
            />
          </Section>
        )}
      </div>
      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'New Category' : 'Rename Category'} detents={['fit']}>
        <form
          class="sheet-pad jump-form"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <input class="text-input" type="text" placeholder="Name" value={name} onInput={(e) => setName(e.currentTarget.value)} enterKeyHint="done" data-testid="category-name" />
          <Button variant="filled" size="large" onClick={commit} disabled={!name.trim()}>
            Save
          </Button>
        </form>
      </Sheet>
    </Screen>
  );
}

// ---------- storage ----------

const STORAGE_ROWS: { key: StorageCategory; label: string; color: string; clearable: boolean; note: string }[] = [
  { key: 'downloads', label: 'Downloads', color: 'var(--blue)', clearable: true, note: 'Chapters you chose to keep offline' },
  { key: 'cache', label: 'Read-ahead cache', color: 'var(--orange)', clearable: true, note: 'Upcoming chapters, evicted automatically' },
  { key: 'covers', label: 'Covers', color: 'var(--green)', clearable: true, note: 'Library cover images' },
  { key: 'meta', label: 'Chapter lists', color: 'var(--purple)', clearable: false, note: 'Saved for novels in your library' },
  { key: 'state', label: 'Library & settings', color: 'var(--gray)', clearable: false, note: 'Synced with iCloud' },
  { key: 'logs', label: 'Logs', color: 'var(--teal)', clearable: true, note: 'Diagnostics' },
];

function StoragePage() {
  const data = useAsync(() => bridge().call('storage.usage'), []);
  const s = settings.value;
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  useEffect(() => {
    if (data.data) setUsage(data.data);
  }, [data.data]);

  const total = usage ? Object.values(usage.bytes).reduce((a, b) => a + b, 0) : 0;

  /** Downloads of novels not in the library (removed ones, kept so Undo works, or never added): deleted only when confirmed. */
  async function deleteOrphans(n: number): Promise<void> {
    const novels = n === 1 ? '1 novel that isn’t' : `${n} novels that aren’t`;
    const i = await actionSheet({ title: `Delete downloads of ${novels} in your library?`, message: 'This can’t be undone.', actions: [{ title: 'Delete', destructive: true }], cancel: 'Cancel' });
    if (i !== 0) return;
    try {
      const r = await bridge().call('downloads.deleteOrphans');
      setUsage(await bridge().call('storage.usage'));
      showToast(r.novels > 0 ? `Deleted downloads of ${plural(r.novels, 'novel')} (${formatBytes(r.bytes)})` : 'Nothing to delete');
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    }
  }

  async function clear(key: Exclude<StorageCategory, 'state' | 'meta'>, label: string): Promise<void> {
    if (!(await confirmAlert(`Clear ${label}?`, key === 'downloads' ? 'Downloaded chapters will be deleted from this iPhone.' : 'This frees space; it will refill as you read.', 'Clear'))) return;
    try {
      setUsage(await bridge().call('storage.clear', { category: key }));
      showToast(`${label} cleared`);
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    }
  }

  return (
    <Screen class="is-grouped" title="Storage" back="More" testId="screen-storage" onRefresh={() => data.reload({ silent: true })}>
      <div class="grouped">
        {data.status === 'error' && data.error && !usage ? (
          <ErrorState error={data.error} onRetry={() => void data.reload()} />
        ) : !usage ? (
          <SkeletonRows count={6} />
        ) : (
          <>
            <Section>
              <div class="storage-summary">
                <p class="storage-total">
                  <span class="tabular">{formatBytes(total)}</span> used
                </p>
                <div class="storage-bar" role="img" aria-label="Storage by category">
                  {STORAGE_ROWS.map((r) => (
                    <span key={r.key} style={{ flexGrow: String(usage.bytes[r.key] || 0.0001), background: r.color }} />
                  ))}
                </div>
                <div class="storage-legend">
                  {STORAGE_ROWS.map((r) => (
                    <span key={r.key}>
                      <i style={{ background: r.color }} />
                      {r.label}
                    </span>
                  ))}
                </div>
              </div>
            </Section>
            <Section>
              {STORAGE_ROWS.map((r) => (
                <Row
                  key={r.key}
                  title={r.label}
                  subtitle={r.note}
                  value={<span class="tabular">{formatBytes(usage.bytes[r.key])}</span>}
                  trailing={
                    r.clearable && r.key !== 'state' && r.key !== 'meta' && usage.bytes[r.key] > 0 ? (
                      <Button variant="gray" size="small" onClick={() => void clear(r.key as Exclude<StorageCategory, 'state' | 'meta'>, r.label)}>
                        Clear
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </Section>
            {usage.orphanDownloads && usage.orphanDownloads.bytes > 0 && (
              <Section footer="Downloads stay when a novel leaves your library, so Undo can bring it back. Novels you downloaded from without adding them count here too.">
                <Row
                  title="Downloads of novels not in your library"
                  subtitle={`${plural(usage.orphanDownloads.novels, 'novel')} · ${formatBytes(usage.orphanDownloads.bytes)}`}
                  trailing={
                    <Button variant="gray" size="small" destructive onClick={() => void deleteOrphans(usage.orphanDownloads?.novels ?? 0)} label="Delete downloads of novels not in your library">
                      Delete
                    </Button>
                  }
                  testId="storage-orphans"
                />
              </Section>
            )}
            <Section header="Limits" footer="Caches never grow past these limits; the oldest items are removed first.">
              <SelectRow
                title="Read-ahead cache"
                value={String(s.cacheCapMB)}
                options={[5, 10, 25, 50].map((n) => ({ value: String(n), label: `${n} MB` }))}
                onChange={(v) => patchSettings({ cacheCapMB: Number(v) })}
              />
              <SelectRow
                title="Cover cache"
                value={String(s.coverCapMB)}
                options={[5, 10, 25, 50].map((n) => ({ value: String(n), label: `${n} MB` }))}
                onChange={(v) => patchSettings({ coverCapMB: Number(v) })}
              />
            </Section>
          </>
        )}
      </div>
    </Screen>
  );
}

// ---------- sources & repositories ----------

function SourcesPage() {
  const [addOpen, setAddOpen] = useState(false);
  return (
    <Screen class="is-grouped" title="Extensions" back="More" testId="screen-sources" right={<BarButton icon="plus" label="Add source" onClick={() => setAddOpen(true)} testId="add-source" />}>
      <ExtensionsPanel addOpen={addOpen} onAddOpenChange={setAddOpen} />
    </Screen>
  );
}

// ---------- about & licenses ----------

function AboutPage() {
  return (
    <Screen class="is-grouped" title="About" back="More" testId="screen-about">
      <div class="about-hero">
        <span class="about-logo">
          <Icon name="books.vertical.fill" size={44} />
        </span>
        <h2 class="about-name">TachiNovel</h2>
        <p class="about-version tabular">
          {aboutVersion(buildVersion.value || __BUILD_VERSION__, __BUILD_HASH__)}
        </p>
      </div>
      <div class="grouped">
        <Section footer="A personal web-novel reader for iPhone, running in Scriptable. Sources use the LNReader plugin format.">
          <Row title="Built" value={new Date(__BUILD_TIME__).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} />
          <Row title="What’s New" chevron onClick={() => (whatsNewOpen.value = true)} testId="about-whats-new" />
          <Row title="Diagnostics" chevron onClick={() => push({ name: 'diagnostics' })} testId="about-diagnostics" />
        </Section>
        <Section header="Credits" footer="TachiNovel’s screens and flow are modeled on LNReader (MIT License) and the look of Tachimanga.">
          <Row title="LNReader" subtitle="github.com/LNReader/lnreader" chevron onClick={() => openInSafari('https://github.com/LNReader/lnreader')} />
          <Row title="LNReader plugins" subtitle="github.com/LNReader/lnreader-plugins" chevron onClick={() => openInSafari('https://github.com/LNReader/lnreader-plugins')} />
          <Row title="Open Source Licenses" chevron onClick={() => push({ name: 'settings', page: 'licenses' })} testId="licenses" />
        </Section>
      </div>
    </Screen>
  );
}

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const LICENSES: { name: string; license: string; text: string }[] = [
  { name: 'LNReader', license: 'MIT License', text: `MIT License\n\nCopyright (c) 2021 Rajarshee Chatterjee\n\n${MIT_BODY}` },
  { name: 'Preact', license: 'MIT License', text: `The MIT License (MIT)\n\nCopyright (c) 2015-present Jason Miller\n\n${MIT_BODY}` },
  { name: '@preact/signals', license: 'MIT License', text: `The MIT License (MIT)\n\nCopyright (c) 2022-present Preact Team\n\n${MIT_BODY}` },
  {
    name: 'DOMPurify',
    license: 'Apache-2.0 OR MPL-2.0',
    text: 'DOMPurify\nCopyright 2025 Dr.-Ing. Mario Heiderich, Cure53\n\nDOMPurify is free software; you can redistribute it and/or modify it under the terms of either:\n\na) the Apache License Version 2.0, or\nb) the Mozilla Public License Version 2.0\n\nhttps://www.apache.org/licenses/LICENSE-2.0\nhttps://www.mozilla.org/MPL/2.0/',
  },
];

function LicensesPage() {
  const [open, setOpen] = useState<string | null>('LNReader');
  return (
    <Screen class="is-grouped" title="Licenses" back="About" testId="screen-licenses">
      <div class="grouped">
        {LICENSES.map((l) => (
          <Section key={l.name}>
            <CheckRow title={l.name} checked={open === l.name} onClick={() => setOpen(open === l.name ? null : l.name)} trailing={<span class="row-value">{l.license}</span>} />
            {open === l.name && <pre class="license-text selectable">{l.text}</pre>}
          </Section>
        ))}
      </div>
    </Screen>
  );
}

// ---------- developer (dev builds only) ----------

function DeveloperPage() {
  const mock = window.__tachiMock;
  const [offline, setOffline] = useState(mock?.flags.offline ?? false);
  const [slow, setSlow] = useState(false);
  const [flaky, setFlaky] = useState((mock?.flags.failRate ?? 0) > 0);
  return (
    <Screen class="is-grouped" title="Developer" back="More" testId="screen-developer">
      <div class="grouped">
        <Section header="Mock bridge" footer="Simulate network conditions to check loading, error and offline states.">
          <SwitchRow
            title="Offline"
            checked={offline}
            onChange={(v) => {
              setOffline(v);
              mock?.setOffline(v);
            }}
          />
          <SwitchRow
            title="Slow network (1.5 s)"
            checked={slow}
            onChange={(v) => {
              setSlow(v);
              mock?.setLatency(v ? 1500 : [80, 260]);
            }}
          />
          <SwitchRow
            title="Flaky network (30% failures)"
            checked={flaky}
            onChange={(v) => {
              setFlaky(v);
              mock?.setFailRate(v ? 0.3 : 0);
            }}
          />
        </Section>
        <Section footer="Sends an app.error event like the script does (e.g. iCloud not ready).">
          <Row
            title="Emit app.error"
            chevron
            onClick={() => mock?.emitError('iCloud isn’t ready yet — using the copy saved on this iPhone. Your changes sync when it is.')}
          />
        </Section>
        <Section>
          <Row title="Bridge calls" value={String(mock?.calls.length ?? 0)} />
        </Section>
      </div>
    </Screen>
  );
}
