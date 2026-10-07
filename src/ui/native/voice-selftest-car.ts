/**
 * Voice self-test, car phase (simulator, Debug builds; see voice-selftest.ts and docs/car.md).
 *
 * A synthetic three-chapter novel (registered natively, no source behind it) plays through the real Listen
 * path while remote commands are sent through the same handler MPRemoteCommandCenter calls
 * (RemoteCommandHub.handle: the system's command events can't be created outside iOS):
 *
 *   buttons-chapters  "Car buttons: chapters" offers ⏮ ⏭, not ±15 s
 *   now-playing       title = chapter, artist = novel, album = TachiNovel, a length, playing rate
 *   auto-advance      the chapter ends → the next one starts by itself; the silence between them is measured
 *   next / previous   ⏭ = next chapter; ⏮ at a chapter's start = the chapter before
 *   toggle            play/pause
 *   skip              +15 s moves forward (a later sentence, or the next chapter)
 *   scrub             position 0 = the chapter's first sentence
 *   buttons-skip      "Car buttons: 15 s" offers ±15 s (interval 15), not ⏮ ⏭
 *   prepare           "Prepare for the drive" renders a chapter with Kokoro into an audio file
 *   prepared-plays    the chapter change continues into the prepared chapter's audio
 * Warnings only (they depend on the simulator's audio output): the Now Playing clock advancing, the
 * prepared chapter finishing and being deleted after listening.
 */
import type { SpeechScript } from '../../core/narration/speech-script.ts';
import { Narration, type NarrationState } from './narration.ts';
import { domSpeechScript } from './speech-dom.ts';

export interface CarStep {
  ok: boolean;
  detail?: string;
}

export interface CarResult {
  steps: Record<string, CarStep>;
  gapsMs: number[];
  warnings: string[];
  nowPlaying?: Record<string, unknown>;
}

const NOVEL = { pluginId: 'voice-selftest', novelPath: 'car-novel', novelName: 'Car Test Novel' } as const;

const CHAPTERS = [
  {
    path: 'car/1',
    title: 'Chapter 1 - The Road',
    paras: [
      'The road ran straight through the fields, and the evening light lay low over the wheat.',
      'Sunny kept both hands on the wheel. Somewhere behind them a dog barked twice.',
      'Nephis watched the hills. She said nothing for a long time, and then she laughed.',
    ],
  },
  {
    path: 'car/2',
    title: 'Chapter 2 - The Bridge',
    paras: [
      'The old bridge appeared just after sunset, black against a copper sky.',
      'They crossed it slowly. The river below was loud and cold and very fast.',
      'On the far side, a single lantern burned in the window of an empty house.',
    ],
  },
  {
    path: 'car/3',
    title: 'Chapter 3 - The House',
    paras: [
      'The door was open. Inside, the table was set for two, and the tea was still warm.',
      'Sunny touched the cup. Then he looked at Nephis, and neither of them sat down.',
      'Far away, a bell rang three times, and the lantern in the window went out.',
    ],
  },
] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(200);
  }
  return pred();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** The narration.chapterText answers for the synthetic novel (scripts built like the reader's). */
function chapterTexts(): { chapterPath: string; title: string; paragraphs: { index: number; text: string }[]; script: SpeechScript }[] {
  return CHAPTERS.map((c, i) => {
    const el = document.createElement('div');
    el.className = 'rd-body';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:-10000px;top:0;width:360px';
    el.innerHTML = [c.title, ...c.paras].map((p) => `<p>${escapeHtml(p)}</p>`).join('');
    document.body.append(el);
    const { script } = domSpeechScript(el, { title: c.title });
    el.remove();
    const prev = CHAPTERS[i - 1];
    const next = CHAPTERS[i + 1];
    return {
      chapterPath: c.path,
      title: c.title,
      paragraphs: [c.title, ...c.paras].map((text, index) => ({ index, text })),
      script,
      ...(next ? { next: { path: next.path, name: next.title } } : {}),
      ...(prev ? { prev: { path: prev.path, name: prev.title } } : {}),
    };
  });
}

export async function runCarPhase(getState: () => NarrationState): Promise<CarResult> {
  const texts = chapterTexts();
  const steps: Record<string, CarStep> = {};
  const warnings: string[] = [];
  const step = (name: string, ok: boolean, detail?: string): void => {
    steps[name] = { ok, ...(detail ? { detail } : {}) };
  };
  const at = (path: string, status: NarrationState['status'] = 'playing'): boolean => getState().chapterPath === path && getState().status === status;
  const nowPlaying = (): Promise<Awaited<ReturnType<typeof Narration.nowPlaying>> | null> => Narration.nowPlaying().catch(() => null);
  const remote = async (command: string, value?: number): Promise<void> => {
    await Narration.remoteCommand({ command, ...(value !== undefined ? { value } : {}) }).catch((err: unknown) => warnings.push(`${command}: ${String(err)}`));
  };
  const play = async (i: number): Promise<boolean> => {
    const c = texts[i];
    if (!c) return false;
    await Narration.play({ ...NOVEL, chapterPath: c.chapterPath, chapterName: c.title, script: c.script, start: { paragraph: 0 }, autoContinue: true, engine: 'speech' });
    return waitUntil(() => at(c.chapterPath), 30_000);
  };
  /** Jump to the chapter's last sentence (the chapter then ends by itself). */
  const nearEnd = async (): Promise<void> => {
    await sleep(800);
    await remote('changePlaybackPosition', Math.max(0, num(getState().duration) - 0.5));
  };

  await Narration.selfTestChapters({ chapters: texts });
  await Narration.setVoiceSettings({ carButtons: 'chapters' }).catch(() => undefined);
  await Narration.clearDrive({ pluginId: NOVEL.pluginId, novelPath: NOVEL.novelPath }).catch(() => undefined);

  // Now Playing + the chapter buttons.
  if (!(await play(0))) step('now-playing', false, `chapter 1 didn't start: ${JSON.stringify(getState())}`);
  await sleep(1500);
  let np = await nowPlaying();
  const cmds = np?.commands ?? {};
  step('buttons-chapters', cmds.nextTrack === true && cmds.previousTrack === true && cmds.skipForward === false && cmds.skipBackward === false, JSON.stringify(cmds));
  const info = np?.info ?? {};
  if (!steps['now-playing']) {
    step('now-playing', info.title === CHAPTERS[0].title && info.artist === NOVEL.novelName && info.album === 'TachiNovel' && num(info.duration) > 0 && num(info.rate) > 0, JSON.stringify(info));
  }
  const e1 = num(info.shownNow ?? info.elapsed);
  await sleep(2000);
  np = await nowPlaying();
  const e2 = num(np?.info.shownNow ?? np?.info.elapsed);
  if (!(e2 > e1)) warnings.push(`the Now Playing time didn't advance (${e1.toFixed(1)} → ${e2.toFixed(1)} s)`);

  // The chapter ends → the next one starts by itself (text fetched ahead, first sentences rendered ahead).
  await nearEnd();
  const advanced = await waitUntil(() => at('car/2'), 60_000);
  await sleep(500);
  np = await nowPlaying();
  const gap = np?.chapterGapsMs?.at(-1);
  step('auto-advance', advanced && gap !== undefined && gap < 2600, `${advanced ? 'chapter 2 started' : 'no chapter change'}${gap !== undefined ? `, ${Math.round(gap)} ms of silence` : ''}`);
  if (gap !== undefined && gap > 800) warnings.push(`chapter change took ${Math.round(gap)} ms (the next chapter's first sentence wasn't rendered ahead?)`);

  // ⏭ / ⏮
  await remote('nextTrack');
  step('next', await waitUntil(() => at('car/3'), 30_000), getState().chapterPath);
  await remote('previousTrack');
  step('previous', await waitUntil(() => at('car/2'), 30_000), getState().chapterPath);

  // Play/pause.
  await sleep(1000);
  await remote('togglePlayPause');
  const paused = await waitUntil(() => getState().status === 'paused', 5000);
  await remote('togglePlayPause');
  const resumed = await waitUntil(() => getState().status === 'playing', 5000);
  step('toggle', paused && resumed, `${paused ? 'paused' : 'not paused'}, ${resumed ? 'resumed' : 'not resumed'}`);

  // +15 s, then back to 0.
  await sleep(800);
  const before = { path: getState().chapterPath, segment: getState().segment ?? -1 };
  await remote('skipForward', 15);
  step('skip', await waitUntil(() => getState().chapterPath !== before.path || (getState().segment ?? -1) > before.segment, 10_000), `${before.path ?? ''}#${before.segment} → ${getState().chapterPath ?? ''}#${getState().segment ?? -1}`);
  const path = getState().chapterPath;
  await sleep(800);
  await remote('changePlaybackPosition', 0);
  step('scrub', await waitUntil(() => getState().chapterPath === path && getState().paragraph === 0 && getState().sentence === 0, 10_000), JSON.stringify({ paragraph: getState().paragraph, sentence: getState().sentence }));

  // "Car buttons: 15 s".
  await Narration.setVoiceSettings({ carButtons: 'skip15' }).catch(() => undefined);
  await sleep(500);
  np = await nowPlaying();
  const skipCmds = np?.commands ?? {};
  step('buttons-skip', skipCmds.skipForward === true && skipCmds.skipBackward === true && skipCmds.nextTrack === false && skipCmds.skipInterval === 15, JSON.stringify(skipCmds));
  await Narration.setVoiceSettings({ carButtons: 'chapters' }).catch(() => undefined);
  await Narration.stop().catch(() => undefined);
  await sleep(800);

  // Prepare chapter 3, then let chapter 2 run into it.
  await Narration.prepareDrive({ ...NOVEL, chapters: 1, when: 'now', startChapterPath: 'car/3' }).catch((err: unknown) => warnings.push(`prepareDrive: ${String(err)}`));
  let prepared: { bytes: number; durationSec: number } | undefined;
  let prepError = '';
  const prepEnd = Date.now() + 240_000;
  while (Date.now() < prepEnd) {
    const s = await Narration.driveStatus({ pluginId: NOVEL.pluginId, novelPath: NOVEL.novelPath }).catch(() => null);
    prepared = s?.prepared.find((c) => c.chapterPath === 'car/3');
    const job = s?.jobs[0];
    if (job?.state === 'failed') prepError = job.error ?? 'failed';
    if (prepared || prepError) break;
    await sleep(1000);
  }
  step('prepare', !!prepared && prepared.bytes > 0 && prepared.durationSec > 0, prepared ? `${prepared.bytes} bytes, ${prepared.durationSec} s` : prepError || 'timed out');

  if (await play(1)) {
    await nearEnd();
    const intoPrepared = await waitUntil(() => getState().chapterPath === 'car/3' && getState().prepared === true, 60_000);
    step('prepared-plays', intoPrepared, JSON.stringify({ chapterPath: getState().chapterPath, engine: getState().engine, prepared: getState().prepared, status: getState().status }));
    // Listened to the end → deleted (needs the simulator's audio output to advance the player).
    const ended = await waitUntil(() => getState().status === 'ended', 60_000);
    const s = await Narration.driveStatus({ pluginId: NOVEL.pluginId, novelPath: NOVEL.novelPath }).catch(() => null);
    if (!ended) warnings.push('the prepared chapter did not play to the end (no audio output in the simulator?)');
    else if (s?.prepared.some((c) => c.chapterPath === 'car/3')) warnings.push('the prepared chapter was not deleted after listening');
  } else {
    step('prepared-plays', false, "chapter 2 didn't start");
  }

  np = await nowPlaying();
  await Narration.stop().catch(() => undefined);
  await Narration.clearDrive({ pluginId: NOVEL.pluginId, novelPath: NOVEL.novelPath }).catch(() => undefined);
  return { steps, gapsMs: np?.chapterGapsMs ?? [], warnings, ...(np ? { nowPlaying: { info: np.info, commands: np.commands } } : {}) };
}
