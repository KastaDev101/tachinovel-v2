/**
 * The app log file. The primary copy lives on device storage (local: fast, never synced, so no iCloud
 * conflict copies); a mirror in iCloud (synced logs/app.log, where it can be read from a computer) is
 * refreshed as a plain in-place overwrite, at most every `mirrorEveryMs` and when forced (session end,
 * fatal error), and only while this instance may write shared files (see run.ts: a second launch that
 * may yield to a running instance keeps the mirror off).
 *
 * Why: the phone produced "logs/app(1).log" conflict copies. The log used to be rewritten in iCloud on
 * every 3 s flush through the atomic write (temp → delete → rename, the same temp name for every
 * writer), and two instances (old view still open + new launch) did that at the same moment.
 */
import type { FileStore, LogLevel } from '../../shared/contracts/platform.ts';

export const LOG_FILE = 'logs/app.log';
export const LOG_ROTATED = 'logs/app.1.log';
export const LOG_CAP_BYTES = 256 * 1024;
export const LOG_MIRROR_EVERY_MS = 60_000;

export interface LogMirror {
  /** Existing mirror content (seeds the device log once, so history isn't lost on the switch). */
  read(path: string): Promise<string | null>;
  /** Overwrite in place: no delete/rename, so iCloud sees one modified file. */
  write(path: string, text: string): Promise<void>;
}

export interface LogFileOptions {
  primary: FileStore;
  mirror: LogMirror | null;
  now(): number;
  capBytes?: number;
  mirrorEveryMs?: number;
  onError?(err: unknown): void;
}

export class LogFile {
  private readonly opts: LogFileOptions;
  private readonly cap: number;
  private readonly every: number;
  private mirrorOn = true;
  private lastMirrorAt = Number.NEGATIVE_INFINITY;
  private seeded = false;
  private rotatedUnmirrored = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: LogFileOptions) {
    this.opts = opts;
    this.cap = opts.capBytes ?? LOG_CAP_BYTES;
    this.every = opts.mirrorEveryMs ?? LOG_MIRROR_EVERY_MS;
  }

  get mirroring(): boolean {
    return this.mirrorOn && this.opts.mirror !== null;
  }

  setMirror(on: boolean): void {
    this.mirrorOn = on;
  }

  /** Append lines (already newline-terminated). Never throws; writes are serialized. */
  append(chunk: string, opts: { forceMirror?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      const { primary } = this.opts;
      let existing = await primary.readText(LOG_FILE);
      if (existing === null && !this.seeded && this.mirroring) existing = await this.opts.mirror?.read(LOG_FILE) ?? null;
      this.seeded = true;
      existing ??= '';
      let current: string;
      if (existing.length > 0 && existing.length + chunk.length > this.cap) {
        await primary.writeText(LOG_ROTATED, existing);
        this.rotatedUnmirrored = true;
        current = chunk;
      } else {
        current = existing + chunk;
      }
      await primary.writeText(LOG_FILE, current);
      await this.mirrorIfDue(current, opts.forceMirror === true);
    });
  }

  /** Push the current device log to the mirror now (session end). */
  mirrorNow(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.mirroring) return;
      const current = await this.opts.primary.readText(LOG_FILE);
      if (current !== null) await this.mirrorIfDue(current, true);
    });
  }

  private async mirrorIfDue(current: string, force: boolean): Promise<void> {
    const { mirror } = this.opts;
    if (!mirror || !this.mirrorOn) return;
    const now = this.opts.now();
    if (!force && now - this.lastMirrorAt < this.every) return;
    this.lastMirrorAt = now;
    if (this.rotatedUnmirrored) {
      const rotated = await this.opts.primary.readText(LOG_ROTATED);
      if (rotated !== null) await mirror.write(LOG_ROTATED, rotated);
      this.rotatedUnmirrored = false;
    }
    await mirror.write(LOG_FILE, current);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((err: unknown) => {
      try {
        this.opts.onError?.(err);
      } catch {
        // nowhere left to report
      }
    });
    this.queue = run;
    return run;
  }
}

// ---------- line format and reading (app.logs) ----------

/**
 * One log line: `<ISO time> <LEVEL> <message>[<TAB><data>]`. The message is kept on one line (newlines
 * and tabs become spaces) and the data payload sits after a tab, so readers can show the message
 * without the payload. Multi-line data is JSON-escaped onto the same line.
 */
export function formatLogLine(at: number, level: LogLevel, message: string, data?: unknown): string {
  const head = `${new Date(at).toISOString()} ${level.toUpperCase()} ${oneLine(message)}`;
  return data === undefined ? head : `${head}\t${dataText(data)}`;
}

function oneLine(s: string): string {
  return /[\t\r\n]/.test(s) ? s.replace(/\r?\n|\r|\t/g, ' ') : s;
}

function dataText(data: unknown): string {
  try {
    const json = typeof data === 'string' ? JSON.stringify(data) : (JSON.stringify(data) ?? '');
    return oneLine(json);
  } catch {
    return '[unserializable]';
  }
}

export interface LogEntry {
  /** Epoch ms. */
  at: number;
  /** 'error' | 'warn' | 'info' | 'debug' */
  level: string;
  message: string;
}

const LINE_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (DEBUG|INFO|WARN|ERROR) /;

/**
 * Lines written before the tab separator had their payload appended after a space; drop a trailing
 * JSON object/array that parses (a few candidates at most, so this stays cheap).
 */
function stripLegacyPayload(message: string): string {
  const last = message.at(-1);
  if (last !== '}' && last !== ']') return message;
  let from = 0;
  for (let tries = 0; tries < 8; tries++) {
    const i = message.slice(from).search(/ [[{]/);
    if (i < 0) return message;
    const at = from + i;
    try {
      JSON.parse(message.slice(at + 1));
      return message.slice(0, at);
    } catch {
      from = at + 1;
    }
  }
  return message;
}

/** A log line → entry (message only, never the data payload); null for continuation/garbage lines. */
export function parseLogLine(line: string, maxMessage = 300): LogEntry | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const at = Date.parse(m[1] as string);
  if (!Number.isFinite(at)) return null;
  const rest = line.slice(m[0].length);
  const tab = rest.indexOf('\t');
  let message = tab >= 0 ? rest.slice(0, tab) : stripLegacyPayload(rest);
  message = message.trimEnd();
  if (message.length > maxMessage) message = `${message.slice(0, maxMessage - 1)}…`;
  return { at, level: (m[2] as string).toLowerCase(), message };
}

/**
 * Newest-first entries at or above `minLevel` from the device log (app.log, then app.1.log).
 * `minLevel` 'warn' = warn + error, 'error' = errors only.
 */
export async function readLogEntries(store: FileStore, opts: { minLevel: 'warn' | 'error'; limit: number; maxMessage?: number }): Promise<LogEntry[]> {
  const wanted = opts.minLevel === 'error' ? ERROR_ONLY : WARN_AND_ERROR;
  const out: LogEntry[] = [];
  for (const file of [LOG_FILE, LOG_ROTATED]) {
    const text = await store.readText(file);
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < opts.limit; i--) {
      const line = lines[i] as string;
      // Cheap level test before parsing (most lines are info).
      if (!wanted.test(line)) continue;
      const entry = parseLogLine(line, opts.maxMessage);
      if (entry) out.push(entry);
    }
    if (out.length >= opts.limit) break;
  }
  return out;
}

const ERROR_ONLY = /^\S+ ERROR /;
const WARN_AND_ERROR = /^\S+ (?:WARN|ERROR) /;
