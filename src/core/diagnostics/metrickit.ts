/**
 * MetricKit diagnostics (crashes, hangs, CPU and disk-write exceptions, slow launches), kept on the
 * device only. iOS hands the app an MXDiagnosticPayload (usually on the next launch); the native side
 * (MetricDiagnostics.swift) forwards its JSON here unchanged. Each diagnostic is:
 *   - summarized into one log line (warn/error), so it shows in Settings › Diagnostics "Recent problems",
 *     "Send a Problem Report" and "Copy Full Diagnostics" like any other problem;
 *   - stored whole (call stacks included, for symbolication) under logs/metrickit/, newest MAX_REPORTS
 *     kept, and shared only when the user taps "Share Crash Reports" (diagnostics.shareReports).
 * Nothing is uploaded. Payload format: https://developer.apple.com/documentation/metrickit/mxdiagnosticpayload
 * (jsonRepresentation). Parsing is defensive: unknown or missing fields are skipped, never thrown on.
 */
import type { FileStore } from '@v1/shared/contracts/platform.ts';

export type DiagnosticKind = 'crash' | 'hang' | 'cpu' | 'diskWrite' | 'launch';

export interface DiagnosticSummary {
  /** Stable id (kind + content hash): the same diagnostic delivered twice is stored once. */
  id: string;
  kind: DiagnosticKind;
  /** When it happened (end of the payload's time window), epoch ms. */
  at: number;
  appVersion?: string;
  osVersion?: string;
  device?: string;
  /** "Crash: EXC_BAD_ACCESS (SIGSEGV)", "Hang: 2.4 sec", … */
  title: string;
  /** Top frames of the attributed thread, "App +0x1a2b". */
  frames: string[];
}

export const REPORTS_DIR = 'logs/metrickit';
export const EXPORT_FILE = 'logs/metrickit-export.json';
export const MAX_REPORTS = 30;
const MAX_FRAMES = 5;

const KEYS: Record<string, DiagnosticKind> = {
  crashDiagnostics: 'crash',
  hangDiagnostics: 'hang',
  cpuExceptionDiagnostics: 'cpu',
  diskWriteExceptionDiagnostics: 'diskWrite',
  appLaunchDiagnostics: 'launch',
};

/** Mach exception types (mach/exception_types.h) and signals, for readable titles. */
const EXCEPTIONS: Record<number, string> = {
  1: 'EXC_BAD_ACCESS',
  2: 'EXC_BAD_INSTRUCTION',
  3: 'EXC_ARITHMETIC',
  4: 'EXC_EMULATION',
  5: 'EXC_SOFTWARE',
  6: 'EXC_BREAKPOINT',
  10: 'EXC_CRASH',
  11: 'EXC_RESOURCE',
  12: 'EXC_GUARD',
};
const SIGNALS: Record<number, string> = { 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 8: 'SIGFPE', 9: 'SIGKILL', 10: 'SIGBUS', 11: 'SIGSEGV', 13: 'SIGPIPE' };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** FNV-1a, 32 bit, hex: a short stable id (not security relevant). */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** MetricKit timestamps look like "2026-10-05 21:14:00" (device local time). */
function parseTime(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : undefined;
}

/** Top frames of the thread the diagnostic is attributed to (or the first thread). */
export function topFrames(diagnostic: Json, max = MAX_FRAMES): string[] {
  const tree = obj(diagnostic.callStackTree);
  const stacks = Array.isArray(tree?.callStacks) ? tree.callStacks.map(obj).filter((s): s is Json => s !== undefined) : [];
  const stack = stacks.find((s) => s.threadAttributed === true) ?? stacks[0];
  const roots = stack && Array.isArray(stack.callStackRootFrames) ? stack.callStackRootFrames : [];
  const out: string[] = [];
  let frame = obj(roots[0]);
  while (frame && out.length < max) {
    const binary = str(frame.binaryName) ?? '?';
    const offset = num(frame.offsetIntoBinaryTextSegment);
    out.push(offset === undefined ? binary : `${binary} +0x${offset.toString(16)}`);
    frame = Array.isArray(frame.subFrames) ? obj(frame.subFrames[0]) : undefined;
  }
  return out;
}

function title(kind: DiagnosticKind, meta: Json): string {
  switch (kind) {
    case 'crash': {
      const type = num(meta.exceptionType);
      const signal = num(meta.signal);
      const reason = obj(meta.exceptionReason);
      const parts = [type !== undefined ? (EXCEPTIONS[type] ?? `exception ${type}`) : undefined, signal !== undefined ? `(${SIGNALS[signal] ?? `signal ${signal}`})` : undefined];
      const objc = reason ? str(reason.exceptionName) ?? str(reason.composedMessage) : undefined;
      const termination = str(meta.terminationReason);
      const head = parts.filter(Boolean).join(' ') || 'unknown exception';
      return `Crash: ${head}${objc ? `, ${objc}` : ''}${termination ? ` [${termination}]` : ''}`;
    }
    case 'hang':
      return `Hang: ${str(meta.hangDuration) ?? 'main thread blocked'}`;
    case 'cpu':
      return `CPU exception: ${str(meta.totalCPUTime) ?? '?'} CPU in ${str(meta.totalSampledTime) ?? '?'}`;
    case 'diskWrite':
      return `Disk writes exception: ${str(meta.writesCaused) ?? '?'} written`;
    case 'launch':
      return `Slow launch: ${str(meta.launchDuration) ?? '?'}`;
  }
}

/** One MXDiagnosticPayload JSON → its diagnostics (summary + the raw diagnostic object). */
export function parsePayload(json: string, now: number): { summary: DiagnosticSummary; raw: Json }[] {
  let payload: Json | undefined;
  try {
    payload = obj(JSON.parse(json));
  } catch {
    return [];
  }
  if (!payload) return [];
  const at = parseTime(payload.timeStampEnd) ?? parseTime(payload.timeStampBegin) ?? now;
  const out: { summary: DiagnosticSummary; raw: Json }[] = [];
  for (const [key, kind] of Object.entries(KEYS)) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const raw = obj(item);
      if (!raw) continue;
      const meta = obj(raw.diagnosticMetaData) ?? {};
      const appVersion = str(meta.appVersion);
      const build = str(meta.appBuildVersion);
      const summary: DiagnosticSummary = {
        id: `${kind}-${hash(JSON.stringify(raw))}`,
        kind,
        at,
        title: title(kind, meta),
        frames: topFrames(raw),
      };
      if (appVersion) summary.appVersion = build ? `${appVersion} (${build})` : appVersion;
      const os = str(meta.osVersion);
      if (os) summary.osVersion = os;
      const device = str(meta.deviceType);
      if (device) summary.device = device;
      out.push({ summary, raw });
    }
  }
  return out;
}

/** Local calendar day: the log line's own time is when the report arrived, usually a launch later. */
function day(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The log line for Diagnostics (kept short: app.logs shows at most 300 characters). */
export function logLine(s: DiagnosticSummary): string {
  const where = [s.appVersion ? `app ${s.appVersion}` : '', s.osVersion ?? '', s.device ?? ''].filter(Boolean).join(', ');
  const frames = s.frames.length > 0 ? ` · ${s.frames.slice(0, 3).join(' ← ')}` : '';
  const line = `MetricKit ${day(s.at)} ${s.title}${where ? ` (${where})` : ''}${frames}`;
  return line.length > 280 ? `${line.slice(0, 279)}…` : line;
}

interface StoredReport {
  summary: DiagnosticSummary;
  diagnostic: Json;
}

const fileName = (s: DiagnosticSummary): string => `${new Date(s.at).toISOString().replace(/[:.]/g, '-')}-${s.id}.json`;

/** Store new diagnostics from a payload, log each once, keep the newest MAX_REPORTS. Returns how many were new. */
export async function recordPayload(local: FileStore, json: string, now: number, log: (level: 'warn' | 'error', message: string) => void): Promise<number> {
  const found = parsePayload(json, now);
  if (found.length === 0) return 0;
  local.mkdirp(REPORTS_DIR);
  const existing = new Set(local.list(REPORTS_DIR));
  const known = new Set([...existing].map((n) => /-((?:crash|hang|cpu|diskWrite|launch)-[0-9a-f]{8})\.json$/.exec(n)?.[1]).filter(Boolean));
  let added = 0;
  // Crashes last, so they are the newest lines and top the Recent Problems list.
  for (const { summary, raw } of [...found].reverse()) {
    if (known.has(summary.id)) continue;
    known.add(summary.id);
    const report: StoredReport = { summary, diagnostic: raw };
    await local.writeText(`${REPORTS_DIR}/${fileName(summary)}`, JSON.stringify(report));
    log(summary.kind === 'crash' ? 'error' : 'warn', logLine(summary));
    added++;
  }
  prune(local);
  return added;
}

/** Newest first. */
function reportFiles(local: FileStore): string[] {
  return local
    .list(REPORTS_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .reverse();
}

function prune(local: FileStore): void {
  for (const name of reportFiles(local).slice(MAX_REPORTS)) local.remove(`${REPORTS_DIR}/${name}`);
}

async function readReports(local: FileStore): Promise<StoredReport[]> {
  const out: StoredReport[] = [];
  for (const name of reportFiles(local)) {
    const text = await local.readText(`${REPORTS_DIR}/${name}`);
    if (!text) continue;
    try {
      const r = JSON.parse(text) as StoredReport;
      if (r && typeof r === 'object' && r.summary && typeof r.summary.id === 'string') out.push(r);
    } catch {
      // A damaged file is skipped, not fatal.
    }
  }
  return out;
}

export async function listReports(local: FileStore): Promise<DiagnosticSummary[]> {
  return (await readReports(local)).map((r) => r.summary);
}

/**
 * Write every stored report into one JSON file for the share sheet. Returns its relative path, or null
 * when there is nothing to share.
 */
export async function exportReports(local: FileStore, meta: { app: string; exportedAt: number }): Promise<string | null> {
  const reports = await readReports(local);
  if (reports.length === 0) return null;
  const doc = {
    format: 'tachinovel-metrickit/1',
    note: 'MetricKit crash and hang reports collected on this device. Frames are binary + offset; symbolicate with the matching dSYM.',
    app: meta.app,
    exportedAt: new Date(meta.exportedAt).toISOString(),
    reports,
  };
  await local.writeText(EXPORT_FILE, JSON.stringify(doc, null, 2));
  return EXPORT_FILE;
}

/** Delete every stored report (and a previous export). Returns how many reports were removed. */
export function clearReports(local: FileStore): number {
  const files = reportFiles(local);
  for (const name of files) local.remove(`${REPORTS_DIR}/${name}`);
  if (local.exists(EXPORT_FILE)) local.remove(EXPORT_FILE);
  return files.length;
}
