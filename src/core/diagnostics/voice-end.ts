/**
 * How the app's last run ended, in plain words, from native (VoiceRun.swift and the voices' crash sentinels, which
 * read HDVoiceCore's RunJournal at launch): "Closed in the background for memory at 2:32 PM, chapter 1026, phone warm.
 * Not counted against Nephis." It becomes one log line, so Settings › Diagnostics ("Recent problems", Copy Full
 * Diagnostics) says what happened after a dropout: a crash of a voice's model is an error, an end while in use the
 * app can't explain is a warning, an update or a swipe-away is info. Text only; nothing is uploaded.
 */

export type VoiceEndLevel = 'info' | 'warn' | 'error';

/** Longest line kept (native's lines are one or two short sentences). */
export const VOICE_END_MAX = 300;

/** The log entry for native's `diagnostics.voiceEnd` args, or null when they carry no message. */
export function voiceEndEntry(args: unknown): { level: VoiceEndLevel; message: string } | null {
  if (!args || typeof args !== 'object') return null;
  const { message, level } = args as { message?: unknown; level?: unknown };
  if (typeof message !== 'string') return null;
  const text = message.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const kept = text.length > VOICE_END_MAX ? `${text.slice(0, VOICE_END_MAX - 1)}…` : text;
  return { level: level === 'error' || level === 'info' ? level : 'warn', message: `Last run: ${kept}` };
}
