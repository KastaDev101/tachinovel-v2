/**
 * JS API of the native Narration plugin (ios/App/App/Native/Narration/NarrationPlugin.swift).
 * Audio runs natively, so playback survives the lock screen, shows in Now Playing / Control Center /
 * the car, and continues into the next chapter without the WebView. Two engines:
 *  - 'audio': PC-narrated chapter files from the linked "TachiNovel Audio" folder (tachinovel-narrator),
 *    with sentence timestamps for highlighting;
 *  - 'speech': the system voice (AVSpeechSynthesizer) for chapters without audio.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

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
  start: { paragraph: number; sentence?: number };
  /** Continue into the next chapter when this one ends. Default true. */
  autoContinue?: boolean;
  /** 'speech' forces the system voice even when a narrated file exists. Default: audio when available. */
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

export interface NarrationState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
  engine?: 'audio' | 'speech';
  pluginId?: string;
  novelPath?: string;
  chapterPath?: string;
  chapterName?: string;
  paragraph?: number;
  sentence?: number;
  /** Audio engine: manifest segment id, chapter position and length (seconds). */
  segment?: number;
  position?: number;
  duration?: number;
  error?: string;
}

export interface NarrationProgress {
  chapterPath: string;
  engine?: 'audio' | 'speech';
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
  addListener(event: 'state', fn: (s: NarrationState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'progress', fn: (p: NarrationProgress) => void): Promise<PluginListenerHandle>;
}

export const Narration = registerPlugin<NarrationPlugin>('Narration');
