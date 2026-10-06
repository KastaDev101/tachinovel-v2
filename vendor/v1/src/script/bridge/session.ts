/**
 * Per-session call statistics for diagnostics (memory only; one `session` log line at close).
 * Records every handled bridge call: method, duration, ok / error code.
 */
import type { BridgeError } from '../../shared/contracts/protocol.ts';
import { isRecord } from '../lib/validate.ts';

/** Calls slower than this are logged immediately (warn). */
export const SLOW_CALL_MS = 1500;
const MAX_DURATIONS_PER_METHOD = 1000;
const MAX_ERRORS = 50;
const SLOWEST = 5;
const MAX_ARGS_SUMMARY = 200;
/** Keep the session line well under the log file cap. */
export const MAX_SESSION_LINE = 32 * 1024;

const ID_KEYS = ['pluginId', 'id', 'path', 'novelPath', 'chapterPath', 'url', 'repoUrl', 'fileName', 'page', 'mode', 'category', 'read', 'refresh', 'finished'];
const LIST_KEYS = ['keys', 'chapterPaths', 'names', 'categoryIds'];

/** ids/paths only (never search terms, text or HTML), max 200 chars. */
export function summarizeArgs(args: unknown): string {
  if (!isRecord(args)) return '';
  const parts: string[] = [];
  const add = (k: string, v: unknown): void => {
    if (typeof v === 'string') parts.push(`${k}=${v.length > 80 ? `${v.slice(0, 79)}…` : v}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${String(v)}`);
  };
  for (const k of ID_KEYS) add(k, args[k]);
  if (isRecord(args.novel)) {
    add('novel.pluginId', args.novel.pluginId);
    add('novel.path', args.novel.path);
  }
  for (const k of LIST_KEYS) if (Array.isArray(args[k])) parts.push(`${k}=[${(args[k] as unknown[]).length}]`);
  const s = parts.join(' ');
  return s.length > MAX_ARGS_SUMMARY ? `${s.slice(0, MAX_ARGS_SUMMARY - 1)}…` : s;
}

interface MethodStats {
  n: number;
  ok: number;
  err: number;
  max: number;
  durations: number[];
}

export interface CallSummary {
  method: string;
  ms: number;
  args: string;
}

export interface SessionSummary {
  /** ms from the server's creation to the summary. */
  sessionMs: number;
  calls: number;
  /** per method: count, ok, errors, median and max ms */
  methods: Record<string, { n: number; ok: number; err: number; p50: number; max: number }>;
  slowest: CallSummary[];
  errors: (CallSummary & { code: string; message: string; atMs: number })[];
  /** Errors beyond the kept ones. */
  moreErrors: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export class SessionRecorder {
  private readonly startedAt: number;
  private readonly methods = new Map<string, MethodStats>();
  private slowest: CallSummary[] = [];
  private readonly errors: SessionSummary['errors'] = [];
  private moreErrors = 0;
  private calls = 0;

  constructor(startedAt: number) {
    this.startedAt = startedAt;
  }

  record(method: string, ms: number, args: unknown, error: BridgeError | null, at: number): void {
    this.calls++;
    let m = this.methods.get(method);
    if (!m) {
      m = { n: 0, ok: 0, err: 0, max: 0, durations: [] };
      this.methods.set(method, m);
    }
    m.n++;
    if (error) m.err++;
    else m.ok++;
    if (ms > m.max) m.max = ms;
    m.durations.push(ms);
    if (m.durations.length > MAX_DURATIONS_PER_METHOD) m.durations.shift();

    const last = this.slowest[this.slowest.length - 1];
    if (this.slowest.length < SLOWEST || (last && ms > last.ms)) {
      this.slowest.push({ method, ms, args: summarizeArgs(args) });
      this.slowest.sort((a, b) => b.ms - a.ms);
      if (this.slowest.length > SLOWEST) this.slowest.length = SLOWEST;
    }
    if (error) {
      if (this.errors.length < MAX_ERRORS) {
        this.errors.push({ method, ms, args: summarizeArgs(args), code: error.code, message: error.message.slice(0, 200), atMs: at - this.startedAt });
      } else {
        this.moreErrors++;
      }
    }
  }

  summary(now: number): SessionSummary {
    const methods: SessionSummary['methods'] = {};
    for (const [name, m] of [...this.methods].sort((a, b) => b[1].n - a[1].n)) {
      methods[name] = { n: m.n, ok: m.ok, err: m.err, p50: median(m.durations), max: m.max };
    }
    return { sessionMs: now - this.startedAt, calls: this.calls, methods, slowest: [...this.slowest], errors: [...this.errors], moreErrors: this.moreErrors };
  }
}

/** JSON for the session log line, trimmed (errors first) to stay under MAX_SESSION_LINE. */
export function sessionLine(data: SessionSummary & Record<string, unknown>): string {
  let text = JSON.stringify(data);
  if (text.length <= MAX_SESSION_LINE) return text;
  const trimmed = { ...data, errors: [...data.errors] };
  while (text.length > MAX_SESSION_LINE && trimmed.errors.length > 0) {
    trimmed.errors.pop();
    trimmed.moreErrors++;
    text = JSON.stringify(trimmed);
  }
  return text.length <= MAX_SESSION_LINE ? text : text.slice(0, MAX_SESSION_LINE);
}
