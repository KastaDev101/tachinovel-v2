/**
 * App settings: defaults, schema validation, deep-merge patches.
 * Stored in synced `settings.json`. Unknown keys in a patch are rejected (INVALID_ARGS); invalid or
 * missing values in a stored file fall back to defaults (forward/backward compatible).
 */
import type { AppSettings, CleanupRule } from '../../shared/contracts/domain.ts';
import { invalidArgs } from '../lib/errors.ts';
import { type Obj, isRecord } from '../lib/validate.ts';
import type { DocSpec } from '../storage/json-doc.ts';

export const SETTINGS_VERSION = 6;

export const MAX_RECENT_SEARCHES = 15;
export const MAX_CLEANUP_RULES = 100;

/** Default source languages (LNReader index `lang` names). */
export const DEFAULT_LANGUAGES: readonly string[] = ['English'];

export function defaultSettings(): AppSettings {
  return {
    schemaVersion: SETTINGS_VERSION,
    appearance: 'system',
    reader: {
      theme: 'system',
      font: 'serif',
      fontSize: 18,
      lineHeight: 1.6,
      paragraphSpacing: 1,
      margin: 20,
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
    },
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
    languages: [...DEFAULT_LANGUAGES],
    autoDownload: { enabled: false, ahead: 3 },
    autoBackup: true,
    cleanupRules: [],
    recentSearches: [],
    readingGoal: null,
  };
}

/** Structural check of a cleanup rule (regex compilation is checked when the rule is applied). */
export function isCleanupRule(v: unknown): v is CleanupRule {
  return (
    isRecord(v) &&
    typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 64 &&
    typeof v.pattern === 'string' && v.pattern.trim().length > 0 && v.pattern.length <= 500 &&
    typeof v.regex === 'boolean' &&
    typeof v.scope === 'string' && v.scope.length > 0 && v.scope.length <= 200 &&
    typeof v.enabled === 'boolean'
  );
}

type Rule =
  | { t: 'bool' }
  | { t: 'num'; min: number; max: number; int?: boolean; nullable?: boolean }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'str'; maxLen: number }
  | { t: 'strs'; min: number; max: number; maxLen: number }
  | { t: 'list'; max: number; item: (v: unknown) => boolean; what: string }
  | { t: 'obj'; fields: Readonly<Record<string, Rule>> }
  /** null, or an object with exactly these (scalar) fields; replaced as a whole, never merged. */
  | { t: 'nobj'; fields: Readonly<Record<string, Rule>> };

const bool: Rule = { t: 'bool' };
const num = (min: number, max: number, extra: { int?: boolean; nullable?: boolean } = {}): Rule => ({ t: 'num', min, max, ...extra });
const oneOf = (...values: string[]): Rule => ({ t: 'enum', values });
const obj = (fields: Record<string, Rule>): Rule => ({ t: 'obj', fields });
const nullableWhole = (fields: Record<string, Rule>): Rule => ({ t: 'nobj', fields });
/** Non-empty string. */
const str = (maxLen: number): Rule => ({ t: 'str', maxLen });
/** Array of non-empty strings (deduplicated, order kept). */
const strs = (min: number, max: number, maxLen: number): Rule => ({ t: 'strs', min, max, maxLen });
/** Array of objects checked by `item` (copied shallowly). */
const list = (max: number, item: (v: unknown) => boolean, what: string): Rule => ({ t: 'list', max, item, what });

const SCHEMA_FIELDS: Readonly<Record<string, Rule>> = {
  appearance: oneOf('system', 'light', 'dark'),
  reader: obj({
    theme: oneOf('system', 'light', 'sepia', 'dark', 'black'),
    font: oneOf('serif', 'sans', 'rounded', 'georgia'),
    fontSize: num(10, 40),
    lineHeight: num(1, 3),
    paragraphSpacing: num(0, 4),
    margin: num(0, 80),
    justify: bool,
    indent: bool,
    tapZones: bool,
    continuous: bool,
    keepAwake: bool,
    showFooter: bool,
    brightness: num(0, 1, { nullable: true }),
    markReadAt: num(0.5, 1),
    paged: bool,
    autoScrollSpeed: num(10, 200),
  }),
  library: obj({
    display: oneOf('comfortable', 'compact', 'list'),
    columns: num(1, 6, { int: true }),
    sort: obj({ by: oneOf('lastRead', 'lastUpdated', 'alpha', 'unread', 'dateAdded'), dir: oneOf('asc', 'desc') }),
    filter: obj({ unread: bool, completed: bool, downloaded: bool }),
    showUnreadBadge: bool,
    showDownloadBadge: bool,
    updateOnOpen: bool,
    /** 'last' | 'ask' | a category id */
    addTo: str(64),
    lastAddCategoryIds: strs(0, 200, 64),
  }),
  readAhead: num(0, 3, { int: true }),
  cacheCapMB: num(0, 1024),
  coverCapMB: num(0, 1024),
  incognito: bool,
  deleteDownloadsAfterRead: bool,
  languages: strs(1, 100, 60),
  autoDownload: obj({ enabled: bool, ahead: num(1, 10, { int: true }) }),
  autoBackup: bool,
  cleanupRules: list(MAX_CLEANUP_RULES, isCleanupRule, 'cleanup rules {id, pattern, regex, scope, enabled}'),
  recentSearches: strs(0, MAX_RECENT_SEARCHES, 200),
  readingGoal: nullableWhole({ minutesPerDay: num(5, 600, { int: true }) }),
};

function valid(rule: Rule, v: unknown): boolean {
  switch (rule.t) {
    case 'bool':
      return typeof v === 'boolean';
    case 'num':
      if (v === null) return rule.nullable === true;
      return typeof v === 'number' && Number.isFinite(v) && v >= rule.min && v <= rule.max && (!rule.int || Number.isInteger(v));
    case 'enum':
      return typeof v === 'string' && rule.values.includes(v);
    case 'str':
      return typeof v === 'string' && v.trim().length > 0 && v.length <= rule.maxLen;
    case 'strs':
      return (
        Array.isArray(v) &&
        v.length >= rule.min &&
        v.length <= rule.max &&
        v.every((x) => typeof x === 'string' && x.trim().length > 0 && x.length <= rule.maxLen)
      );
    case 'list':
      return Array.isArray(v) && v.length <= rule.max && v.every((x) => rule.item(x));
    case 'obj':
      return isRecord(v);
    case 'nobj':
      if (v === null) return true;
      return (
        isRecord(v) &&
        Object.keys(v).every((k) => Object.hasOwn(rule.fields, k)) &&
        Object.entries(rule.fields).every(([k, r]) => valid(r, v[k]))
      );
  }
}

/** Fresh copy of an array value (strings deduplicated, objects copied shallowly). */
function copyArray(v: unknown[]): unknown[] {
  return v.every((x) => typeof x === 'string') ? [...new Set(v)] : v.map((x) => (isRecord(x) ? { ...x } : x));
}

function describe(rule: Rule): string {
  switch (rule.t) {
    case 'bool':
      return 'a boolean';
    case 'num':
      return `a number in [${rule.min}, ${rule.max}]${rule.int ? ' (integer)' : ''}${rule.nullable ? ' or null' : ''}`;
    case 'enum':
      return `one of ${rule.values.join(', ')}`;
    case 'str':
      return `a non-empty string (max ${rule.maxLen})`;
    case 'strs':
      return `an array of ${rule.min}–${rule.max} non-empty strings`;
    case 'list':
      return `an array (max ${rule.max}) of ${rule.what}`;
    case 'obj':
      return 'an object';
    case 'nobj':
      return `null or { ${Object.entries(rule.fields).map(([k, r]) => `${k}: ${describe(r)}`).join(', ')} }`;
  }
}

function applyInto(target: Obj, patch: Obj, fields: Readonly<Record<string, Rule>>, path: string): void {
  for (const key of Object.keys(patch)) {
    const at = path ? `${path}.${key}` : key;
    const rule = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!rule) throw invalidArgs(`Unknown setting "${at}"`);
    const value = patch[key];
    if (value === undefined) continue;
    if (!valid(rule, value)) throw invalidArgs(`Setting "${at}" must be ${describe(rule)}`);
    if (rule.t === 'obj') {
      const sub = target[key];
      const next: Obj = isRecord(sub) ? sub : {};
      target[key] = next;
      applyInto(next, value as Obj, rule.fields, at);
    } else {
      target[key] = Array.isArray(value) ? copyArray(value) : isRecord(value) ? { ...value } : value;
    }
  }
}

/** Validate and deep-merge a patch. Returns a new settings object; the input is not modified. */
export function applySettingsPatch(current: AppSettings, patch: unknown): AppSettings {
  if (!isRecord(patch)) throw invalidArgs('patch must be an object');
  const next = JSON.parse(JSON.stringify(current)) as Obj;
  applyInto(next, patch, SCHEMA_FIELDS, '');
  next.schemaVersion = SETTINGS_VERSION;
  return next as unknown as AppSettings;
}

function sanitizeInto(defaults: Obj, stored: unknown, fields: Readonly<Record<string, Rule>>): Obj {
  const src = isRecord(stored) ? stored : {};
  const out: Obj = {};
  for (const key of Object.keys(fields)) {
    const rule = fields[key] as Rule;
    const d = defaults[key];
    if (rule.t === 'obj') out[key] = sanitizeInto(d as Obj, src[key], rule.fields);
    else if (valid(rule, src[key])) out[key] = Array.isArray(src[key]) ? copyArray(src[key] as unknown[]) : isRecord(src[key]) ? { ...src[key] } : src[key];
    else out[key] = Array.isArray(d) ? [...(d as unknown[])] : d;
  }
  return out;
}

/** Stored settings merged over defaults; invalid values replaced, unknown keys dropped. */
export function sanitizeSettings(stored: unknown): AppSettings {
  const out = sanitizeInto(defaultSettings() as unknown as Obj, stored, SCHEMA_FIELDS);
  out.schemaVersion = SETTINGS_VERSION;
  return out as unknown as AppSettings;
}

export const SETTINGS_SPEC: DocSpec<AppSettings> = {
  path: 'settings.json',
  version: SETTINGS_VERSION,
  create: defaultSettings,
  migrations: {
    0: (doc) => doc,
    // v2 changed the default library display to 'compact'. Existing users keep what they had: a stored
    // value stays, and a missing one means they were on the old default ('comfortable').
    1: (doc) => {
      const library = isRecord(doc.library) ? doc.library : {};
      if (!['comfortable', 'compact', 'list'].includes(library.display as string)) library.display = 'comfortable';
      return { ...doc, library };
    },
    // v3 added source languages; existing installs get English only (what the user asked for).
    2: (doc) => ({ ...doc, languages: [...DEFAULT_LANGUAGES] }),
    // v4 added smart downloads, daily backups, cleanup rules, recent searches, paged/auto-scroll reading.
    // Existing installs start with the same defaults as new ones.
    3: (doc) => {
      const d = defaultSettings();
      const reader = isRecord(doc.reader) ? { ...doc.reader } : {};
      reader.paged ??= d.reader.paged;
      reader.autoScrollSpeed ??= d.reader.autoScrollSpeed;
      return {
        ...doc,
        reader,
        autoDownload: doc.autoDownload ?? d.autoDownload,
        autoBackup: doc.autoBackup ?? d.autoBackup,
        cleanupRules: doc.cleanupRules ?? d.cleanupRules,
        recentSearches: doc.recentSearches ?? d.recentSearches,
      };
    },
    // v5: where library.add puts novels ('last' used categories by default).
    4: (doc) => {
      const library = isRecord(doc.library) ? { ...doc.library } : {};
      library.addTo ??= 'last';
      library.lastAddCategoryIds ??= [];
      return { ...doc, library };
    },
    // v6: optional daily reading goal (Reading Insights); nobody has one until they set it.
    5: (doc) => ({ ...doc, readingGoal: doc.readingGoal ?? null }),
  },
  normalize: (doc) => sanitizeSettings(doc),
};
