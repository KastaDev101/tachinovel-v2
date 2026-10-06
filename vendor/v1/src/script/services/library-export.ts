/**
 * library.export: the library as a CSV (UTF-8 with BOM, RFC 4180 quoting, CRLF, so Numbers and Excel
 * open it right) or a plain-text list, written to local `exports/tachinovel-library-YYYY-MM-DD.<csv|txt>`
 * and handed to the share sheet. Only the newest MAX_EXPORTS files are kept.
 * Per novel: name, source, URL, chapters read / total, status, categories, last read date. Counts only:
 * no chapter paths or positions. An explicit export, so incognito doesn't hide anything.
 */
import type { LibraryEntry } from '../../shared/contracts/domain.ts';
import { localDate as localDay } from '../lib/dates.ts';
import { errorMessage } from '../lib/errors.ts';
import { isHttpUrl } from '../lib/validate.ts';
import type { Ctx } from './context.ts';
import type { LibraryService } from './library.ts';
import type { SourceService } from './sources.ts';

export const EXPORTS_DIR = 'exports';
export const MAX_EXPORTS = 3;
/** UTF-8 byte-order mark: tells Numbers/Excel the CSV is UTF-8. */
const BOM = String.fromCharCode(0xfeff);

export interface ExportRow {
  name: string;
  source: string;
  url: string;
  read: number;
  total: number;
  status: string;
  categories: string;
  lastRead: string;
}


/** One CSV field: quoted when it holds a comma, quote, line break or edge spaces; quotes doubled. */
export function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly ExportRow[]): string {
  const header = ['Name', 'Source', 'URL', 'Chapters read', 'Chapters', 'Status', 'Categories', 'Last read'];
  const lines = [header.join(',')];
  for (const r of rows) lines.push([r.name, r.source, r.url, r.read, r.total, r.status, r.categories, r.lastRead].map(csvField).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

export function toText(rows: readonly ExportRow[], at: number): string {
  const blocks = rows.map((r) => {
    const facts = [`Read ${r.read} of ${r.total} chapters`, r.status, r.categories ? `Categories: ${r.categories}` : ''].filter(Boolean).join(' · ');
    return [`${r.name} (${r.source})`, r.url, facts, r.lastRead ? `Last read ${r.lastRead}` : ''].filter(Boolean).join('\n');
  });
  return `TachiNovel library, ${localDay(at)}: ${rows.length} novel${rows.length === 1 ? '' : 's'}\n\n${blocks.join('\n\n')}\n`;
}

const STATUS: Record<string, string> = { ongoing: 'Ongoing', completed: 'Completed', hiatus: 'On hiatus', cancelled: 'Cancelled', unknown: '' };

export class LibraryExport {
  private readonly ctx: Ctx;
  private readonly library: LibraryService;
  private readonly sources: SourceService;

  constructor(ctx: Ctx, deps: { library: LibraryService; sources: SourceService }) {
    this.ctx = ctx;
    this.library = deps.library;
    this.sources = deps.sources;
  }

  /** A novel's web page: the plugin's own resolveUrl when it loads, else the source site + path. */
  private async urlResolver(): Promise<(e: LibraryEntry) => string> {
    const adapters = new Map<string, ((path: string) => string) | null>();
    for (const id of new Set(this.library.all().map((e) => e.pluginId))) {
      if (!this.sources.get(id)) {
        adapters.set(id, null);
        continue;
      }
      try {
        const a = await this.sources.adapter(id, 'background');
        adapters.set(id, (path) => a.resolveUrl(path, true));
      } catch (err) {
        this.ctx.platform.log('info', `Export: ${id} not loaded (${errorMessage(err)}); using its site + path`);
        adapters.set(id, null);
      }
    }
    return (e) => {
      if (isHttpUrl(e.path)) return e.path;
      try {
        const viaPlugin = adapters.get(e.pluginId)?.(e.path);
        if (viaPlugin && isHttpUrl(viaPlugin)) return viaPlugin;
      } catch {
        // fall back below
      }
      const site = this.sources.get(e.pluginId)?.site ?? '';
      return site ? `${site.replace(/\/+$/, '')}/${e.path.replace(/^\/+/, '')}` : '';
    };
  }

  async rows(): Promise<ExportRow[]> {
    const url = await this.urlResolver();
    const categories = new Map(this.library.categories().map((c) => [c.id, c.name] as const));
    return this.library
      .all()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({
        name: e.name,
        source: this.sources.get(e.pluginId)?.name ?? e.pluginId,
        url: url(e),
        read: Math.max(0, e.chapterCount - e.unreadCount),
        total: e.chapterCount,
        status: STATUS[e.status ?? 'unknown'] ?? '',
        categories: e.categoryIds
          .map((id) => categories.get(id))
          .filter((n): n is string => !!n)
          .join('; '),
        lastRead: e.lastReadAt ? localDay(e.lastReadAt) : '',
      }));
  }

  /** Write the export file, keep the newest few, and open the share sheet with it. */
  async export(format: 'csv' | 'text'): Promise<{ fileName: string; novels: number }> {
    const { local, native } = this.ctx.platform;
    const now = this.ctx.platform.now();
    const rows = await this.rows();
    const ext = format === 'csv' ? 'csv' : 'txt';
    const base = `tachinovel-library-${localDay(now)}`;
    let fileName = `${base}.${ext}`;
    for (let n = 2; local.exists(`${EXPORTS_DIR}/${fileName}`); n++) fileName = `${base}-${n}.${ext}`;
    await local.writeText(`${EXPORTS_DIR}/${fileName}`, format === 'csv' ? toCsv(rows) : toText(rows, now));
    this.prune(fileName);
    await native.shareFile(local.absolute(`${EXPORTS_DIR}/${fileName}`)); // a dismissed sheet just resolves
    return { fileName, novels: rows.length };
  }

  /** Keep the newest MAX_EXPORTS files (the one just written always stays). */
  private prune(keep: string): void {
    const { local } = this.ctx.platform;
    const files = local
      .list(EXPORTS_DIR)
      .filter((f) => f.startsWith('tachinovel-library-'))
      .map((f) => ({ f, at: local.modifiedAt(`${EXPORTS_DIR}/${f}`) ?? 0 }))
      .sort((a, b) => b.at - a.at || b.f.localeCompare(a.f));
    let kept = 0;
    for (const { f } of files) {
      if (f === keep || kept < MAX_EXPORTS - 1) {
        if (f !== keep) kept++;
        continue;
      }
      try {
        local.remove(`${EXPORTS_DIR}/${f}`);
      } catch (err) {
        this.ctx.platform.log('warn', `Old export ${f} not removed: ${errorMessage(err)}`);
      }
    }
  }
}
