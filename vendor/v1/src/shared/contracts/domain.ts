/**
 * Domain types shared by the script side and the UI. Plain JSON-serializable data only.
 * Owned by the coordinator; agents request changes instead of editing.
 */

/** A novel is identified by its plugin and the plugin's novelPath. */
export interface NovelKey {
  pluginId: string;
  path: string;
}

/** `${pluginId}:${path}` — pluginIds never contain ':' so split on the first one. */
export type NovelKeyString = string;

export function novelKeyString(k: NovelKey): NovelKeyString {
  return `${k.pluginId}:${k.path}`;
}

export function parseNovelKey(s: NovelKeyString): NovelKey {
  const i = s.indexOf(':');
  if (i <= 0) throw new Error(`Invalid novel key: ${s}`);
  return { pluginId: s.slice(0, i), path: s.slice(i + 1) };
}

export type NovelStatus = 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown';

/**
 * Browse/search result. `cover` is an absolute https URL, or (library entries only) a path relative
 * to the UI file for locally cached covers, e.g. "covers/ab12.webp". Undefined → placeholder.
 */
export interface NovelSummary extends NovelKey {
  name: string;
  cover?: string;
  /** Total chapters if known (from the source listing, or from stored metadata). */
  chapterCount?: number;
}

export interface NovelDetails extends NovelSummary {
  author?: string;
  artist?: string;
  status: NovelStatus;
  /** Plain text (paragraphs separated by \n). */
  summary?: string;
  genres: string[];
  /** 0..5 */
  rating?: number;
  /** Absolute URL of the novel on the source site, for "Open in Safari". */
  url?: string;
}

/** Trimmed chapter metadata (what we store and send). Ordered oldest → newest. */
export interface ChapterMeta {
  path: string;
  name: string;
  number?: number;
  /** ISO date or display string, as given by the source. */
  releaseTime?: string;
  /** Paywalled/coin-locked: shown, never fetched. */
  locked?: boolean;
}

/** Chapter as shown in the novel page: metadata + per-user state. */
export interface ChapterView extends ChapterMeta {
  read: boolean;
  bookmarked: boolean;
  downloaded: boolean;
  /** 0..1 progress if partially read. */
  progress?: number;
}

export interface ChapterPosition {
  /** 0..1 scroll fraction within the chapter. */
  percent: number;
  /** Index of the first visible paragraph (robust to font/size changes). */
  paragraph: number;
  /** Pixel offset inside that paragraph at the time of saving. */
  offset?: number;
}

export interface LibraryEntry extends NovelSummary {
  key: NovelKeyString;
  status?: NovelStatus;
  author?: string;
  addedAt: number;
  lastReadAt?: number;
  /** When new chapters were last detected. */
  lastUpdatedAt?: number;
  chapterCount: number;
  unreadCount: number;
  downloadedCount: number;
  categoryIds: string[];
  /** Where "continue reading" goes. */
  lastChapterPath?: string;
  lastChapterName?: string;
}

export interface Category {
  id: string;
  name: string;
  order: number;
}

export interface HistoryEntry extends NovelKey {
  novelName: string;
  cover?: string;
  chapterPath: string;
  chapterName: string;
  readAt: number;
  percent: number;
  /** Total active reading time for this novel (sum of progress.save gaps under 60 s). */
  readingMs?: number;
}

export interface UpdateEntry extends NovelKey {
  novelName: string;
  cover?: string;
  chapterPath: string;
  chapterName: string;
  foundAt: number;
  read: boolean;
  /** Chapter is saved in downloads (filled by the script). */
  downloaded?: boolean;
}

export type ReaderTheme = 'system' | 'light' | 'sepia' | 'dark' | 'black';
export type ReaderFont = 'serif' | 'sans' | 'rounded' | 'georgia';

export interface ReaderSettings {
  theme: ReaderTheme;
  font: ReaderFont;
  /** px */
  fontSize: number;
  /** unitless multiplier */
  lineHeight: number;
  /** em */
  paragraphSpacing: number;
  /** px, horizontal */
  margin: number;
  justify: boolean;
  indent: boolean;
  tapZones: boolean;
  /** Continuous scroll into the next chapter. */
  continuous: boolean;
  keepAwake: boolean;
  showFooter: boolean;
  /** 0..1, or null to leave system brightness alone. */
  brightness: number | null;
  /** Mark a chapter read once scrolled past this fraction. */
  markReadAt: number;
  /** Paged (swipe pages like a book) instead of vertical scrolling. Default false. */
  paged: boolean;
  /** Auto-scroll speed in px/s when auto-scroll is started from the reader. Default 40. */
  autoScrollSpeed: number;
}

/** Hide junk lines in chapter text (ads, "Read at …", translator notes). Applied script-side to chapter HTML. */
export interface CleanupRule {
  id: string;
  /** Plain text (case-insensitive "contains") or a regex source when `regex` is true. */
  pattern: string;
  regex: boolean;
  /** '*' = every source, otherwise a pluginId. */
  scope: string;
  enabled: boolean;
}

export interface ReadingStats {
  /** Oldest → newest, one entry per local calendar day in the requested range. */
  days: { date: string; ms: number; chapters: number }[];
  streakDays: number;
  totalMs: number;
  topNovels: { key: NovelKeyString; name: string; cover?: string; ms: number }[];
}

export type LibrarySortBy = 'lastRead' | 'lastUpdated' | 'alpha' | 'unread' | 'dateAdded';

export interface LibrarySettings {
  display: 'comfortable' | 'compact' | 'list';
  columns: number;
  sort: { by: LibrarySortBy; dir: 'asc' | 'desc' };
  filter: { unread: boolean; completed: boolean; downloaded: boolean };
  showUnreadBadge: boolean;
  showDownloadBadge: boolean;
  updateOnOpen: boolean;
  /**
   * Category for newly added novels: 'last' (default) = reuse the categories picked last time (one tap,
   * toast offers "Change"), 'ask' = always show the picker, or a specific category id.
   */
  addTo: string; // 'last' | 'ask' | <categoryId>
  /** Categories chosen on the most recent add (used by 'last'). Empty = Default. */
  lastAddCategoryIds: string[];
}

export interface AppSettings {
  schemaVersion: number;
  appearance: 'system' | 'light' | 'dark';
  reader: ReaderSettings;
  library: LibrarySettings;
  /** Chapters fetched ahead while reading (0..3). */
  readAhead: number;
  /** Hard caps for the auto-evicting caches. */
  cacheCapMB: number;
  coverCapMB: number;
  incognito: boolean;
  deleteDownloadsAfterRead: boolean;
  /** Source languages to show (LNReader index `lang` names, e.g. "English"). Default ["English"]. */
  languages: string[];
  /** Keep the next N unread chapters of novels you're reading downloaded (opt-in, size-capped). */
  autoDownload: { enabled: boolean; ahead: number };
  /** Write a backup automatically once a day (keeps the newest 10). Default true. */
  autoBackup: boolean;
  cleanupRules: CleanupRule[];
  /** Most recent first, max 15. */
  recentSearches: string[];
  /** Daily reading goal shown in Reading Insights; null = no goal (default). */
  readingGoal: { minutesPerDay: number } | null;
}

export interface SourceInfo {
  id: string;
  name: string;
  site: string;
  version: string;
  lang: string;
  iconUrl?: string;
  enabled: boolean;
  pinned: boolean;
  /** Shipped with the app (e.g. Stonescape). */
  builtIn: boolean;
  hasFilters: boolean;
  /** Repo index URL it was installed from, if any. */
  repoUrl?: string;
  /** Newer version available in its repo. */
  updateAvailable?: string;
  lastUsedAt?: number;
}

export interface RepoInfo {
  url: string;
  name: string;
  pluginCount: number;
  fetchedAt?: number;
}

export interface AvailablePlugin {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  url: string;
  iconUrl?: string;
  repoUrl: string;
  installed: boolean;
  installedVersion?: string;
  /** From the shipped plugins/verified.json sweep (PC-side; phone results may differ for Cloudflare sites). */
  verified?: 'works' | 'partial' | 'broken';
}

export type StorageCategory = 'state' | 'meta' | 'cache' | 'covers' | 'downloads' | 'logs';

export interface StorageUsage {
  /** Bytes per category. */
  bytes: Record<StorageCategory, number>;
  caps: { cacheBytes: number; coverBytes: number };
}

export interface DeviceInfo {
  model: string;
  systemVersion: string;
  batteryLevel: number;
  charging: boolean;
  brightness: number;
  dark: boolean;
}
