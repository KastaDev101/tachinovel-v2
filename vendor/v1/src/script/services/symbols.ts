/**
 * SF Symbol cache: rendered once by Scriptable (PNG → data URL), kept in local `symbols.json` and
 * returned in the boot payload so icons paint without a round trip. Reset when the build changes.
 */
import { JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';

interface SymbolsDoc {
  schemaVersion: number;
  build: string;
  /** name → latest rendering. */
  symbols: Record<string, { size: number; data: string }>;
}

export const DEFAULT_SYMBOL_SIZE = 24;
const MAX_SYMBOLS = 400;

export class SymbolService {
  private readonly ctx: Ctx;
  private readonly doc: JsonDoc<SymbolsDoc>;

  private constructor(ctx: Ctx, doc: JsonDoc<SymbolsDoc>) {
    this.ctx = ctx;
    this.doc = doc;
  }

  static async load(ctx: Ctx, build: string): Promise<SymbolService> {
    const doc = await JsonDoc.load<SymbolsDoc>(
      ctx.platform.local,
      {
        path: 'symbols.json',
        version: 1,
        create: () => ({ schemaVersion: 1, build, symbols: {} }),
        normalize: (d) => {
          if (d.build !== build || !d.symbols || typeof d.symbols !== 'object') return { schemaVersion: 1, build, symbols: {} };
          // Only well-formed cache rows (they go to the UI as image data URLs).
          const symbols: SymbolsDoc['symbols'] = {};
          for (const [name, v] of Object.entries(d.symbols as Record<string, unknown>)) {
            const row = v as { size?: unknown; data?: unknown } | null;
            if (row && typeof row.size === 'number' && typeof row.data === 'string' && row.data.startsWith('data:image/png;base64,')) symbols[name] = { size: row.size, data: row.data };
          }
          return { schemaVersion: d.schemaVersion, build, symbols };
        },
      },
      ctx.timing.indexWriteMs,
      ctx.env,
    );
    return new SymbolService(ctx, doc);
  }

  /** name → data URL; unknown symbols are omitted. */
  render(names: readonly string[], size = DEFAULT_SYMBOL_SIZE): Record<string, string> {
    const out: Record<string, string> = {};
    const cache = this.doc.value.symbols;
    let changed = false;
    for (const name of names) {
      const hit = Object.hasOwn(cache, name) ? cache[name] : undefined;
      if (hit && hit.size === size) {
        out[name] = hit.data;
        continue;
      }
      const png = this.ctx.platform.native.symbol(name, size);
      if (!png) continue;
      const data = `data:image/png;base64,${png}`;
      if (Object.hasOwn(cache, name)) delete cache[name];
      cache[name] = { size, data };
      out[name] = data;
      changed = true;
    }
    const keys = Object.keys(cache);
    for (let i = 0; i < keys.length - MAX_SYMBOLS; i++) delete cache[keys[i] as string];
    if (changed) this.doc.changed();
    return out;
  }

  /** Everything rendered before, for the boot payload. */
  bootMap(): Record<string, string> {
    const out: Record<string, string> = {};
    const cache = this.doc.value.symbols;
    for (const name of Object.keys(cache)) out[name] = (cache[name] as { data: string }).data;
    return out;
  }

  flush(): Promise<void> {
    return this.doc.flush();
  }
}
