import type { AppSettings, ReaderSettings } from '../../shared/contracts/domain.ts';

/** Comfortable reading defaults: ~18px New York, 1.6 line height, generous margins. */
export const DEFAULT_READER: ReaderSettings = {
  theme: 'system',
  font: 'serif',
  fontSize: 18,
  lineHeight: 1.6,
  paragraphSpacing: 0.9,
  margin: 22,
  justify: false,
  indent: false,
  tapZones: true,
  continuous: true,
  keepAwake: true,
  showFooter: true,
  brightness: null,
  markReadAt: 0.95,
  paged: false,
  autoScrollSpeed: 40,
};

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  appearance: 'system',
  reader: DEFAULT_READER,
  library: {
    display: 'compact',
    columns: 3,
    sort: { by: 'lastRead', dir: 'desc' },
    filter: { unread: false, completed: false, downloaded: false },
    showUnreadBadge: true,
    showDownloadBadge: true,
    updateOnOpen: false,
    addTo: 'last',
    lastAddCategoryIds: [],
  },
  readAhead: 1,
  cacheCapMB: 10,
  coverCapMB: 10,
  incognito: false,
  deleteDownloadsAfterRead: false,
  languages: ['English'],
  autoDownload: { enabled: false, ahead: 3 },
  autoBackup: true,
  cleanupRules: [],
  recentSearches: [],
  readingGoal: null,
};

export const READER_LIMITS = {
  fontSize: { min: 13, max: 32, step: 1 },
  lineHeight: { min: 1.2, max: 2.2, step: 0.1 },
  paragraphSpacing: { min: 0, max: 2, step: 0.1 },
  margin: { min: 8, max: 48, step: 2 },
} as const;
