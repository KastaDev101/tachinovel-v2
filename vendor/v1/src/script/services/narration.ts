/**
 * PC narration settings and status (narration.get / narration.set).
 *
 * - Config: synced `audio.json`, read by tachinovel-narrator on the PC. Written by the app only, through
 *   the usual atomic JsonDoc write; loaded lazily (never on the boot path). Stored values are cleaned
 *   leniently on load; narration.set validates strictly (INVALID_ARGS).
 * - Status: synced `narration-status.json`, written by the PC narrator. The app NEVER writes, moves or
 *   repairs it: it is read fresh on every narration.get, validated defensively (it's an external
 *   file), and reported as null when missing or unusable.
 */
import type { NarrationConfig, NarrationStatus } from '../../shared/contracts/domain.ts';
import { errorMessage, invalidArgs } from '../lib/errors.ts';
import { isRecord } from '../lib/validate.ts';
import { type DocSpec, JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';
import { isNum, isStr, keyIsValid } from './records.ts';

export const AUDIO_PATH = 'audio.json';
export const NARRATION_STATUS_PATH = 'narration-status.json';

export const NARRATION_LIMITS = {
  aheadMin: 1,
  aheadMax: 30,
  speedMin: 0.7,
  speedMax: 1.3,
  bundleMin: 2,
  bundleMax: 30,
  maxNovels: 200,
} as const;

const VOICE_RE = /^[a-z][a-z_]{0,31}$/;
/** Status files bigger than this are not parsed (a broken writer must not stall the app). */
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_NOVELS = 500;
const MAX_READY_RANGES = 1000;
const MAX_ERROR_CHARS = 500;
const MAX_NAME_CHARS = 300;

export function defaultNarrationConfig(): NarrationConfig {
  return { novels: [], voice: 'af_heart', speed: 0.94, bundle: 0 };
}

interface AudioDoc extends NarrationConfig {
  schemaVersion: number;
}

const isAhead = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= NARRATION_LIMITS.aheadMin && v <= NARRATION_LIMITS.aheadMax;
const isSpeed = (v: unknown): v is number => isNum(v) && v >= NARRATION_LIMITS.speedMin && v <= NARRATION_LIMITS.speedMax;
const isBundle = (v: unknown): v is number =>
  isNum(v) && Number.isInteger(v) && (v === 0 || (v >= NARRATION_LIMITS.bundleMin && v <= NARRATION_LIMITS.bundleMax));
const isVoice = (v: unknown): v is string => isStr(v) && VOICE_RE.test(v);

/** Stored config made usable: bad novels dropped (duplicates keep the first), bad fields → defaults. */
export function sanitizeNarrationConfig(v: unknown): NarrationConfig {
  const d = defaultNarrationConfig();
  if (!isRecord(v)) return d;
  const seen = new Set<string>();
  const novels: NarrationConfig['novels'] = [];
  for (const n of Array.isArray(v.novels) ? v.novels : []) {
    if (novels.length >= NARRATION_LIMITS.maxNovels) break;
    if (!isRecord(n) || !isStr(n.key) || !keyIsValid(n.key) || !isAhead(n.ahead) || seen.has(n.key)) continue;
    seen.add(n.key);
    novels.push({ key: n.key, ahead: n.ahead });
  }
  return {
    novels,
    voice: isVoice(v.voice) ? v.voice : d.voice,
    speed: isSpeed(v.speed) ? v.speed : d.speed,
    bundle: isBundle(v.bundle) ? v.bundle : d.bundle,
  };
}

/** narration.set: strict validation of a full config (INVALID_ARGS names the first problem). */
export function validateNarrationConfig(v: unknown): NarrationConfig {
  const L = NARRATION_LIMITS;
  if (!isRecord(v)) throw invalidArgs('config must be an object');
  for (const k of Object.keys(v)) if (!['novels', 'voice', 'speed', 'bundle'].includes(k)) throw invalidArgs(`Unknown narration setting "${k}"`);
  if (!Array.isArray(v.novels)) throw invalidArgs('config.novels must be an array');
  if (v.novels.length > L.maxNovels) throw invalidArgs(`config.novels can list at most ${L.maxNovels} novels`);
  const seen = new Set<string>();
  const novels: NarrationConfig['novels'] = [];
  v.novels.forEach((n: unknown, i: number) => {
    if (!isRecord(n)) throw invalidArgs(`config.novels[${i}] must be an object`);
    if (!isStr(n.key) || !keyIsValid(n.key)) throw invalidArgs(`config.novels[${i}].key must be a novel key ("pluginId:path")`);
    if (!isAhead(n.ahead)) throw invalidArgs(`config.novels[${i}].ahead must be a whole number from ${L.aheadMin} to ${L.aheadMax}`);
    if (seen.has(n.key)) throw invalidArgs(`config.novels lists ${n.key} twice`);
    seen.add(n.key);
    novels.push({ key: n.key, ahead: n.ahead });
  });
  if (!isVoice(v.voice)) throw invalidArgs('config.voice must be a voice id (lowercase letters and "_", e.g. "af_heart")');
  if (!isSpeed(v.speed)) throw invalidArgs(`config.speed must be a number from ${L.speedMin} to ${L.speedMax}`);
  if (!isBundle(v.bundle)) throw invalidArgs(`config.bundle must be 0 or a whole number from ${L.bundleMin} to ${L.bundleMax}`);
  return { novels, voice: v.voice, speed: v.speed, bundle: v.bundle };
}

/** The narrator's status file made safe to show, or null if it isn't usable at all. */
export function parseNarrationStatus(v: unknown): NarrationStatus | null {
  if (!isRecord(v) || !isNum(v.generatedAt) || !Array.isArray(v.novels)) return null;
  const novels: NarrationStatus['novels'] = [];
  for (const n of v.novels) {
    if (novels.length >= MAX_STATUS_NOVELS) break;
    if (!isRecord(n) || !isStr(n.key) || !keyIsValid(n.key)) continue;
    const ready: { from: number; to: number }[] = [];
    for (const r of Array.isArray(n.ready) ? n.ready : []) {
      if (ready.length >= MAX_READY_RANGES) break;
      if (isRecord(r) && isNum(r.from) && isNum(r.to) && r.from <= r.to) ready.push({ from: r.from, to: r.to });
    }
    const count = (x: unknown): number => (isNum(x) && x > 0 ? Math.floor(x) : 0);
    const entry: NarrationStatus['novels'][number] = {
      key: n.key,
      name: isStr(n.name) && n.name ? n.name.slice(0, MAX_NAME_CHARS) : n.key,
      ready,
      queued: count(n.queued),
      failed: count(n.failed),
    };
    // Chapters the narrator skipped because they're paid / not free yet: a whole count, else left out.
    if (isNum(n.locked) && Number.isInteger(n.locked) && n.locked >= 0) entry.locked = n.locked;
    if (isNum(n.lastRunAt)) entry.lastRunAt = n.lastRunAt;
    if (isStr(n.error) && n.error) entry.error = n.error.slice(0, MAX_ERROR_CHARS);
    novels.push(entry);
  }
  return { generatedAt: v.generatedAt, novels };
}

export const AUDIO_SPEC: DocSpec<AudioDoc> = {
  path: AUDIO_PATH,
  version: 1,
  create: () => ({ schemaVersion: 1, ...defaultNarrationConfig() }),
  normalize: (d) => ({ schemaVersion: 1, ...sanitizeNarrationConfig(d) }),
};

export class NarrationService {
  private readonly ctx: Ctx;
  private doc: Promise<JsonDoc<AudioDoc>> | null = null;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  private load(): Promise<JsonDoc<AudioDoc>> {
    this.doc ??= JsonDoc.load(this.ctx.platform.synced, AUDIO_SPEC, this.ctx.timing.settingsWriteMs, this.ctx.env).catch((err: unknown) => {
      this.doc = null; // retried on the next call
      throw err;
    });
    return this.doc;
  }

  async config(): Promise<NarrationConfig> {
    const { novels, voice, speed, bundle } = (await this.load()).value;
    return { novels: novels.map((n) => ({ ...n })), voice, speed, bundle };
  }

  async set(raw: unknown): Promise<NarrationConfig> {
    const next = validateNarrationConfig(raw);
    const doc = await this.load();
    doc.value = { schemaVersion: 1, ...next };
    doc.changed();
    return this.config();
  }

  /** Read fresh each time (the PC narrator rewrites it); never written, moved or repaired here. */
  async status(): Promise<NarrationStatus | null> {
    const { synced } = this.ctx.platform;
    try {
      if (!synced.exists(NARRATION_STATUS_PATH)) return null;
      if (synced.size(NARRATION_STATUS_PATH) > MAX_STATUS_BYTES) {
        this.ctx.platform.log('warn', `${NARRATION_STATUS_PATH} is too large to read; ignored`);
        return null;
      }
      const text = await synced.readText(NARRATION_STATUS_PATH);
      if (!text) return null;
      const status = parseNarrationStatus(JSON.parse(text));
      if (!status) this.ctx.platform.log('warn', `${NARRATION_STATUS_PATH} has an unexpected format; ignored`);
      return status;
    } catch (err) {
      this.ctx.platform.log('warn', `${NARRATION_STATUS_PATH} unreadable; ignored: ${errorMessage(err)}`);
      return null;
    }
  }

  async flush(): Promise<void> {
    if (this.doc) await (await this.doc).flush();
  }
}
