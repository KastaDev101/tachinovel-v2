/**
 * JS API of the native Narration plugin (ios/App/App/Native/Narration/NarrationPlugin.swift).
 * Audio runs natively, so playback survives the lock screen, shows in Now Playing / Control Center /
 * the car, and continues into the next chapter without the WebView. Engines:
 *  - 'speech': Kokoro-82M on device (bundled model, the default voice) with the Apple system voice taking
 *    over sentence by sentence when Kokoro can't keep up; `source` says which one spoke;
 *  - 'audio': chapter audio files: chapters prepared on this iPhone ("Prepare for the drive", `prepared`),
 *    or PC-narrated files from the linked "TachiNovel Audio" folder, only with Settings › Voices › Advanced ›
 *    "Use PC audio when available" (off by default).
 * In the car: Now Playing + remote commands (CarPlay's Now Playing screen, steering wheel, Siri), see
 * docs/car.md.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { SpeechScript } from '../../core/narration/speech-script.ts';

export interface NarrationParagraphIn {
  index: number;
  text: string;
}

export interface PlayOptions {
  pluginId: string;
  novelPath: string;
  chapterPath: string;
  novelName: string;
  chapterName: string;
  /** Absolute https URL or capacitor:// local cover; used for Now Playing artwork. */
  coverUrl?: string;
  /** Paragraphs exactly as the reader rendered them (speech engine). Omit to let native ask the core. */
  paragraphs?: NarrationParagraphIn[];
  /** Sentence script built from the reader's DOM (speech-dom.ts); preferred over `paragraphs`. */
  script?: SpeechScript;
  start: { paragraph: number; sentence?: number };
  /** Continue into the next chapter when this one ends. Default true. */
  autoContinue?: boolean;
  /** 'speech' forces speech even when a narrated file exists (PC audio is used only when enabled). */
  engine?: 'audio' | 'speech';
}

export interface NarrationVoice {
  id: string;
  name: string;
  language: string;
  quality: 'default' | 'enhanced' | 'premium';
  personal: boolean;
  engine: 'system' | 'neural';
}

export interface LexiconEntry {
  /** Word or phrase as written (case-insensitive, whole word). */
  grapheme: string;
  /** IPA (AVSpeechSynthesisIPANotationAttribute for the system engine; phonemes for neural). */
  ipa?: string;
  /** Plain-text respelling used when no IPA is given ("Nephis" → "Neff-iss"). */
  say?: string;
}

export interface NarrationOptions {
  voiceId?: string;
  /** 0.5 … 2.0 (1 = normal). */
  rate?: number;
  pitch?: number;
  lexicon?: LexiconEntry[];
  /** Pause after each paragraph / scene break, seconds. */
  paragraphPause?: number;
  scenePause?: number;
  /** Stop after N minutes (sleep timer); 0 = off. */
  sleepMinutes?: number;
}

export type VoiceSource = 'kokoro' | 'apple';

export interface SpeakingVoice {
  /** Kokoro voice chosen for this novel. */
  kokoroVoice: string;
  kokoroName: string;
  /** Who spoke the current sentence. */
  source?: VoiceSource;
  /** Apple voice name while it stands in for Kokoro, and why. */
  appleName?: string;
  fallback?: 'modelLoading' | 'modelUnavailable' | 'queueDry' | 'thermal' | 'segmentFailed' | 'disabled';
  /** Kokoro's own status while the system voice stands in ("Turned off after crashing twice", …). */
  kokoroStatus?: string;
}

export type CarButtons = 'chapters' | 'skip15';

export interface NarrationState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
  engine?: 'audio' | 'speech';
  /** Audio engine: a chapter prepared on this iPhone (Kokoro, "Prepare for the drive"). */
  prepared?: boolean;
  /** What the car's side buttons do (Settings › Voices › In the car). */
  carButtons?: CarButtons;
  /** Speech: which voice speaks. */
  voice?: SpeakingVoice;
  pluginId?: string;
  novelPath?: string;
  chapterPath?: string;
  chapterName?: string;
  paragraph?: number;
  sentence?: number;
  /** Manifest segment id (audio). Chapter position and length in seconds at 1×: exact for audio, estimated
   * from the text for speech (refined as sentences are spoken). */
  segment?: number;
  position?: number;
  duration?: number;
  error?: string;
}

export interface NarrationProgress {
  chapterPath: string;
  engine?: 'audio' | 'speech';
  /** Speech: who speaks this sentence. */
  source?: VoiceSource;
  /** Speech: the sentence in the chapter's canonical blocks (speech-script.ts), for highlighting. */
  block?: number;
  start?: number;
  end?: number;
  hash?: number;
  /** Speech: reader paragraph index. Audio: the manifest's block index (the UI re-aligns, see highlight.ts). */
  paragraph: number;
  sentence?: number;
  /** Audio: manifest segment id + chapter time (s). */
  segment?: number;
  t?: number;
  /** UTF-16 range: speech = inside the sentence; audio = inside the block's canonical text. */
  charStart?: number;
  charEnd?: number;
}

export interface AudioChapterInfo {
  chapterPath: string;
  title: string;
  number: number | null;
  hasTiming: boolean;
}

export interface AudioNovelInfo {
  key: string;
  pluginId: string;
  novelPath: string;
  name: string;
  chapters: AudioChapterInfo[];
  saved: { chapterPath: string; seconds: number } | null;
}

export interface KokoroVoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: 'female' | 'male';
  blurb: string;
  /** Kokoro's own grade for the voice (A best … F), and its rank (higher is better). */
  grade?: string;
  gradeRank?: number;
}

export interface VoiceSettingsInfo {
  voices: KokoroVoiceInfo[];
  defaultVoice: string;
  kokoroEnabled: boolean;
  usePCAudio: boolean;
  carButtons?: CarButtons;
  /** Listen player: speed 0.5–2.5 and "Voice volume" 0–1.5 (persisted, every voice). */
  speed?: number;
  volume?: number;
  speedPresets?: number[];
  kokoro: { bundled: boolean; status: string; ready: boolean; crashDisabled: boolean; crashes: number; revision: string | null; bytes: number | null };
  /** The Apple voice that stands in for Kokoro; onlyDefault → suggest downloading a Premium voice. */
  apple: { id?: string; name: string; language?: string; quality: 'default' | 'enhanced' | 'premium'; onlyDefault: boolean };
  /** With pluginId/novelPath: the novel's own choice (null = the default) and the voice it uses. */
  novelVoice?: string | null;
  effectiveVoice?: string;
}

/** One "Prepare for the drive" request. */
export interface DriveJobInfo {
  novelKey: string;
  pluginId: string;
  novelPath: string;
  novelName: string;
  /** Chapters asked for, and done so far (prepared now or already). */
  count: number;
  done: number;
  titles: string[];
  when: 'now' | 'chargingOrWifi';
  voice: string;
  state: 'running' | 'waiting' | 'queued' | 'done' | 'failed';
  /** Why it waits (charging/Wi-Fi, live narration, heat). */
  reason?: string;
  error?: string;
  /** The chapter being rendered: sentences done of all. */
  current?: { chapterPath: string; title: string; sentence: number; sentences: number };
}

export interface PreparedChapterInfo {
  novelKey: string;
  chapterPath: string;
  title: string;
  voice: string;
  bytes: number;
  durationSec: number;
  createdAt: number;
}

export interface DriveStatus {
  jobs: DriveJobInfo[];
  prepared: PreparedChapterInfo[];
  /** Bytes for the novel asked about (or all). */
  bytes: number;
  totalBytes: number;
  capBytes: number;
}

export interface NarrationPlugin {
  play(opts: PlayOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  skip(opts: { unit: 'sentence' | 'paragraph' | 'seconds'; count: number }): Promise<void>;
  seek(opts: { seconds: number }): Promise<void>;
  setOptions(opts: NarrationOptions): Promise<void>;
  voices(): Promise<{ voices: NarrationVoice[] }>;
  /** iOS 17+: ask for Personal Voice access (system prompt). */
  requestPersonalVoice(): Promise<{ status: 'authorized' | 'denied' | 'unsupported' | 'notDetermined' }>;
  state(): Promise<NarrationState>;
  /** Continue a novel where reading/listening stopped (audio first, system voice otherwise). */
  playNovel(opts: { pluginId: string; novelPath: string; novelName: string; coverUrl?: string }): Promise<void>;
  audioFolder(): Promise<{ linked: boolean; name?: string | null }>;
  /** Document picker for the iCloud Drive "TachiNovel Audio" folder (kept as a bookmark). */
  pickAudioFolder(): Promise<{ linked: boolean; name?: string; cancelled?: boolean }>;
  unlinkAudioFolder(): Promise<{ linked: boolean }>;
  audioLibrary(opts?: { refresh?: boolean }): Promise<{ linked: boolean; novels: AudioNovelInfo[] }>;
  /** Timestamp manifest JSON (v1 experiments/tts/manifest.ts) of a narrated chapter, or null. */
  audioTiming(opts: { pluginId: string; novelPath: string; chapterPath: string }): Promise<{ hasAudio: boolean; json: string | null }>;
  /** Voices: Kokoro voices, defaults, per-novel choice, Apple fallback. */
  voiceSettings(opts?: { pluginId?: string; novelPath?: string }): Promise<VoiceSettingsInfo>;
  setVoiceSettings(opts: {
    defaultVoice?: string;
    /** voice null = use the default for this novel. */
    novel?: { pluginId: string; novelPath: string; voice: string | null };
    usePCAudio?: boolean;
    kokoroEnabled?: boolean;
    carButtons?: CarButtons;
    /** 0.5–2.5 (0.05 steps). */
    speed?: number;
    /** 0–1.5 ("Voice volume"; above 1 a limiter keeps it clean). */
    volume?: number;
  }): Promise<void>;
  /** ▶ a sample: a Kokoro voice id, or 'apple'. Resolves when audio starts (ms = time to first audio). */
  sampleVoice(opts: { voice: string; text?: string; runs?: { t?: string; p?: string }[] }): Promise<{ ms: number; source: VoiceSource }>;
  stopSample(): Promise<void>;
  /** Voice Lab numbers (hidden: Settings › About › tap the version 5 times). */
  voiceLab(): Promise<Record<string, unknown>>;
  setVoiceLab(opts: { route?: string; ahead?: number; resetStats?: boolean; inject?: { delayMs?: number; fail?: boolean } }): Promise<Record<string, unknown>>;
  /** Voice Lab: where Core ML runs each Kokoro stage on this device (per-operation plan, no synthesis). */
  voicePlacement(): Promise<{ stages: { stage: string; configured: string; ane: number; cpu: number; gpu: number; error: string | null; summary: string }[] }>;
  /** Simulator voice self-test only (-tachiVoiceSelfTest): write the report file. */
  selfTestReport(opts: { json: string }): Promise<{ path: string | null }>;
  /** "Prepare for the drive": render the next `chapters` chapters with Kokoro (from `startChapterPath`, else
   * where listening would resume), now or while charging / on Wi-Fi. Replaces the novel's earlier request. */
  prepareDrive(opts: { pluginId: string; novelPath: string; novelName: string; coverUrl?: string; chapters: number; when: 'now' | 'chargingOrWifi'; startChapterPath?: string }): Promise<DriveStatus>;
  cancelDrive(opts: { pluginId: string; novelPath: string }): Promise<void>;
  /** One novel's request and prepared chapters, or everything (no args). */
  driveStatus(opts?: { pluginId?: string; novelPath?: string }): Promise<DriveStatus>;
  /** Delete prepared audio: one novel, or all (no args). */
  clearDrive(opts?: { pluginId?: string; novelPath?: string }): Promise<DriveStatus>;
  /** What the lock screen / car show now and which remote commands are offered (Voice Lab, self-test). */
  nowPlaying(): Promise<{ info: Record<string, unknown>; commands: Record<string, unknown>; state: NarrationState; carPlayTemplates: boolean; chapterGapsMs?: number[] }>;
  /** Simulator self-test only: a remote command through the handler MPRemoteCommandCenter calls. */
  remoteCommand(opts: { command: string; value?: number }): Promise<{ handled: boolean }>;
  /** Simulator self-test only: a synthetic novel (narration.chapterText answers by chapterPath). */
  selfTestChapters(opts: { chapters: unknown[] }): Promise<{ chapters: number }>;
  addListener(event: 'state', fn: (s: NarrationState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'progress', fn: (p: NarrationProgress) => void): Promise<PluginListenerHandle>;
  addListener(event: 'drive', fn: (s: DriveStatus) => void): Promise<PluginListenerHandle>;
}

export const Narration = registerPlugin<NarrationPlugin>('Narration');
