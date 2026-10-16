/**
 * Voice files that ship inside the app: ios/App/App/BuiltInVoices/, bundled as a folder (tools/ios-project.ts).
 *   breaths/   recorded inhales for natural delivery (HybridSpeechEngine.breathPack): small WAVs
 *   pocket/    the Pocket TTS voices (the Narrator, its performed and mood reads, Nephis) and the speaker projection
 *              her flow engine needs, each checked like the app checks it (ExpressiveCore/PocketVoice.swift)
 * (The Chatterbox Nano voices, .tnvoice + voices.json, were removed on 2026-10-16.)
 *
 *   node tools/built-in-voices.ts list     what ships, and every problem; exits 1 if anything is invalid
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const BUILT_IN_VOICES_DIR = path.join(root, 'ios', 'App', 'App', 'BuiltInVoices');

/** BuiltInVoices/breaths/: the breath pack that ships with the voices. */
export const BREATHS_DIR = 'breaths';
const BREATH_MAX_BYTES = 100 * 1024;
const BREATHS_MAX_BYTES = 2 * 1024 * 1024;

/** Only `.wav` files, each a short clip, all together small. */
export function checkBreaths(dir: string): string[] {
  const problems: string[] = [];
  let total = 0;
  for (const f of readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (!f.toLowerCase().endsWith('.wav') || statSync(p).isDirectory()) {
      problems.push(`${BREATHS_DIR}/${f}: only .wav files belong in BuiltInVoices/${BREATHS_DIR}/`);
      continue;
    }
    const size = statSync(p).size;
    total += size;
    if (size > BREATH_MAX_BYTES) problems.push(`${BREATHS_DIR}/${f}: ${Math.round(size / 1024)} KB is too long for a breath`);
    if (readFileSync(p).subarray(0, 4).toString('latin1') !== 'RIFF') problems.push(`${BREATHS_DIR}/${f}: not a WAV file`);
  }
  if (total > BREATHS_MAX_BYTES) problems.push(`${BREATHS_DIR}/: ${Math.round(total / 1024)} KB in all (at most ${BREATHS_MAX_BYTES / 1024} KB)`);
  return problems;
}

/** BuiltInVoices/pocket/: the Narrator voice for Pocket TTS (ExpressiveCore/PocketVoice.swift, same rules). */
export const POCKET_DIR = 'pocket';
export const POCKET_VOICE = 'narrator.pocketvoice';
export const POCKET_MANIFEST = 'narrator.json';
const POCKET_EXT = '.pocketvoice';
const POCKET_DIM = 1024;
const POCKET_MAX_FRAMES = 125;
/** Pocket TTS's speaker projection + latent normalization for Nephis's flow engine (ExpressiveCore/NephisFlow.swift). */
export const POCKET_PROJECTION = 'speaker-projection';
const POCKET_LATENT = 32;

/** Every <name>.pocketvoice + <name>.json pair (the Narrator, and its performed read "character"); narrator required. */
export function checkPocketVoice(dir: string): string[] {
  const problems: string[] = [];
  const files = readdirSync(dir).sort();
  const names = new Set<string>();
  for (const f of files) {
    if (f === `${POCKET_PROJECTION}.bin` || f === `${POCKET_PROJECTION}.json`) continue;
    if (f.endsWith(POCKET_EXT)) names.add(f.slice(0, -POCKET_EXT.length));
    else if (f.endsWith('.json')) names.add(f.slice(0, -'.json'.length));
    else problems.push(`${POCKET_DIR}/${f}: only <name>${POCKET_EXT} + <name>.json pairs belong in BuiltInVoices/${POCKET_DIR}/`);
  }
  if (!names.has('narrator')) problems.push(`${POCKET_DIR}/: needs ${POCKET_VOICE} and ${POCKET_MANIFEST}`);
  for (const name of names) problems.push(...checkPocketPair(dir, name));
  if (existsSync(path.join(dir, `${POCKET_PROJECTION}.bin`)) || existsSync(path.join(dir, `${POCKET_PROJECTION}.json`))) {
    problems.push(...checkProjection(dir));
  }
  return problems;
}

/** speaker-projection.bin: [1024 × 32] projection, then emb_std [32], emb_mean [32], float32, matching its manifest. */
function checkProjection(dir: string): string[] {
  const bin = path.join(dir, `${POCKET_PROJECTION}.bin`);
  const manifest = path.join(dir, `${POCKET_PROJECTION}.json`);
  if (!existsSync(bin) || !existsSync(manifest)) return [`${POCKET_DIR}/: ${POCKET_PROJECTION} needs .bin and .json`];
  const problems: string[] = [];
  const data = readFileSync(bin);
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  const bytes = (POCKET_DIM * POCKET_LATENT + 2 * POCKET_LATENT) * 4;
  if (m.embeddingDim !== POCKET_DIM || m.latentDim !== POCKET_LATENT) problems.push(`${POCKET_DIR}/${POCKET_PROJECTION}.json: dims must be ${POCKET_DIM} × ${POCKET_LATENT}`);
  if (data.length !== bytes || m.bytes !== bytes) problems.push(`${POCKET_DIR}/${POCKET_PROJECTION}.bin: ${data.length} bytes, expected ${bytes}`);
  if (typeof m.sha256 !== 'string' || createHash('sha256').update(data).digest('hex') !== m.sha256.toLowerCase()) {
    problems.push(`${POCKET_DIR}/${POCKET_PROJECTION}.bin: doesn’t match the manifest’s sha256`);
  }
  return problems;
}

function checkPocketPair(dir: string, name: string): string[] {
  const problems: string[] = [];
  const voiceFile = `${name}${POCKET_EXT}`;
  const manifestFile = `${name}.json`;
  const where = (f: string) => `${POCKET_DIR}/${f}`;
  if (!existsSync(path.join(dir, voiceFile)) || !existsSync(path.join(dir, manifestFile))) {
    return [`${POCKET_DIR}/: ${name} needs ${voiceFile} and ${manifestFile}`];
  }
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(readFileSync(path.join(dir, manifestFile), 'utf8')) as Record<string, unknown>;
  } catch (err) {
    return [`${where(manifestFile)}: ${err instanceof Error ? err.message : String(err)}`];
  }
  const data = readFileSync(path.join(dir, voiceFile));
  const frames = m.frames;
  if (m.schemaVersion !== 1) problems.push(`${where(manifestFile)}: schemaVersion must be 1`);
  if (m.engine !== 'pocket-tts') problems.push(`${where(manifestFile)}: engine must be pocket-tts`);
  if (m.embeddingDim !== POCKET_DIM) problems.push(`${where(manifestFile)}: embeddingDim must be ${POCKET_DIM}`);
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1 || frames > POCKET_MAX_FRAMES) {
    problems.push(`${where(manifestFile)}: frames must be 1…${POCKET_MAX_FRAMES}`);
  } else if (m.bytes !== frames * POCKET_DIM * 4 || data.length !== m.bytes) {
    problems.push(`${where(voiceFile)}: ${data.length} bytes, expected ${frames} × ${POCKET_DIM} float32`);
  }
  if (typeof m.sha256 !== 'string' || createHash('sha256').update(data).digest('hex') !== m.sha256.toLowerCase()) {
    problems.push(`${where(voiceFile)}: doesn’t match the manifest’s sha256`);
  }
  if (data.length % 4 === 0) {
    for (let i = 0; i < data.length; i += 4) {
      if (!Number.isFinite(data.readFloatLE(i))) {
        problems.push(`${where(voiceFile)}: value ${i / 4} isn’t a finite number`);
        break;
      }
    }
  }
  return problems;
}

/** Everything in BuiltInVoices/ checked with the app's rules; problems instead of throwing (CI test + `list`). */
export function checkBuiltInVoices(dir = BUILT_IN_VOICES_DIR): { problems: string[] } {
  if (!existsSync(dir)) return { problems: [`${dir} is missing`] };
  const problems: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    const isDir = statSync(path.join(dir, file)).isDirectory();
    if (file === BREATHS_DIR && isDir) problems.push(...checkBreaths(path.join(dir, file)));
    else if (file === POCKET_DIR && isDir) problems.push(...checkPocketVoice(path.join(dir, file)));
    // The whole folder goes into the app: nothing else belongs here.
    else problems.push(`${file}: only ${BREATHS_DIR}/ and ${POCKET_DIR}/ belong in BuiltInVoices/`);
  }
  if (!existsSync(path.join(dir, POCKET_DIR))) problems.push(`${POCKET_DIR}/ is missing`);
  return { problems };
}

function main(argv: string[]): number {
  if (argv[0] !== 'list' && argv[0] !== 'check') {
    console.error('usage: node tools/built-in-voices.ts list');
    return 2;
  }
  const { problems } = checkBuiltInVoices();
  for (const f of readdirSync(BUILT_IN_VOICES_DIR).sort()) console.log(`  ${f}/  ${readdirSync(path.join(BUILT_IN_VOICES_DIR, f)).length} files`);
  for (const p of problems) console.error(`problem: ${p}`);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
