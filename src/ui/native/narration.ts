/**
 * JS API of the native Narration plugin (ios/App/App/Native/Narration/NarrationPlugin.swift).
 * Audio runs natively (AVSpeechSynthesizer now; a neural engine later, docs/tts-v2.md), so playback
 * survives the lock screen, shows in Now Playing / Control Center / CarPlay, and continues into the
 * next chapter without the WebView (native asks the core for `narration.chapterText`).
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
  /** Paragraphs exactly as the reader rendered them (exact highlight alignment). Omit to let native ask the core. */
  paragraphs?: NarrationParagraphIn[];
  start: { paragraph: number; sentence?: number };
  /** Continue into the next chapter when this one ends (asks the core for its text). Default true. */
  autoContinue?: boolean;
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
  pluginId?: string;
  novelPath?: string;
  chapterPath?: string;
  chapterName?: string;
  paragraph?: number;
  sentence?: number;
  error?: string;
}

export interface NarrationProgress {
  chapterPath: string;
  paragraph: number;
  sentence: number;
  /** UTF-16 range inside the sentence currently spoken (word highlight), when the engine reports it. */
  charStart?: number;
  charEnd?: number;
}

export interface NarrationPlugin {
  play(opts: PlayOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  skip(opts: { unit: 'sentence' | 'paragraph'; count: number }): Promise<void>;
  setOptions(opts: NarrationOptions): Promise<void>;
  voices(): Promise<{ voices: NarrationVoice[] }>;
  /** iOS 17+: ask for Personal Voice access (system prompt). */
  requestPersonalVoice(): Promise<{ status: 'authorized' | 'denied' | 'unsupported' | 'notDetermined' }>;
  state(): Promise<NarrationState>;
  addListener(event: 'state', fn: (s: NarrationState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'progress', fn: (p: NarrationProgress) => void): Promise<PluginListenerHandle>;
}

export const Narration = registerPlugin<NarrationPlugin>('Narration');
