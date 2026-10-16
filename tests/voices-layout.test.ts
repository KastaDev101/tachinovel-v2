/**
 * More › Voices (cleanup 2, 2026-10-16), the pure parts of src/ui/native/voices-ui.ts: her Narrator and Dialogue rows,
 * the inline download of her model, and the backup voice (her matched Kokoro voice until another is picked).
 */
import { describe, expect, it } from 'vitest';
import type { KokoroVoiceInfo } from '../src/ui/native/narration.ts';
import { backupChoice, dialogueValue, downloadSize, herDownload, MATCHED_VOICE, narratorValue, recommendedVoices } from '../src/ui/native/voices-ui.ts';

const v = (id: string, name: string, grade: string, gradeRank: number): KokoroVoiceInfo => ({ id, name, language: 'en-US', gender: 'female', blurb: '', grade, gradeRank });
const voices = [v('af_bella', 'Bella', 'A-', 12), v('af_nephis', 'Nephis', 'B', 10), v('af_heart', 'Heart', 'A', 13), v('af_nicole', 'Nicole', 'B-', 9), v('af_sky', 'Sky', 'C-', 5)];

describe('More › Voices › Nephis', () => {
  it('names her packs: "<pack> · Studio" with the studio on, the built-in voice without a pack, unknown until status answers', () => {
    expect(narratorValue(null)).toBeNull();
    expect(narratorValue({})).toBeNull(); // an older build's status without nephisPack
    expect(narratorValue({ nephisPack: null })).toBe('Built-in voice');
    expect(narratorValue({ nephisPack: { name: 'nephis-r10', studio: true, studioOn: true } })).toBe('nephis-r10 · Studio');
    expect(narratorValue({ nephisPack: { name: 'nephis-r10', studio: true, studioOn: false } })).toBe('nephis-r10');
    expect(narratorValue({ nephisPack: { name: null, studio: false } })).toBe('Unnamed pack');
    expect(dialogueValue(null)).toBeNull();
    expect(dialogueValue({ dialoguePack: null })).toBe('Uses the narrator');
    expect(dialogueValue({})).toBe('Uses the narrator');
    expect(dialogueValue({ dialoguePack: { name: 'nephis-dialogue', role: 'dialogue' } })).toBe('nephis-dialogue');
  });

  it('reads her model’s download from ExpressiveVoice.status (the Pocket TTS engine)', () => {
    expect(herDownload(null)).toEqual({ state: 'idle', fraction: 0, error: '', bytes: null, installed: null });
    const status = (download: unknown, extra: Record<string, unknown> = {}): unknown => ({
      engines: [{ id: 'chatterbox-nano', download: { state: 'downloading', fraction: 0.9 } }, { id: 'pocket-tts', bytes: 372_000_000, installed: false, download, ...extra }],
    });
    expect(herDownload(status({ state: 'downloading', fraction: 0.42 }))).toEqual({ state: 'downloading', fraction: 0.42, error: '', bytes: 372_000_000, installed: false });
    expect(herDownload(status({ state: 'downloading', fraction: 7 })).fraction).toBe(1);
    expect(herDownload(status({ state: 'failed', error: 'The network connection was lost.' })).error).toBe('The network connection was lost.');
    expect(herDownload(status({ state: 'idle' }, { installed: true })).installed).toBe(true);
    expect(downloadSize(372_000_000)).toBe('~372 MB');
    expect(downloadSize(null)).toBe('~370 MB');
  });
});

describe('More › Voices › Backup Voice', () => {
  const info = { voices, customVoices: [{ id: 'mix-1', name: 'Warm', a: 'af_heart', b: 'af_bella', percent: 40 }], defaultVoice: 'af_heart' };

  it('is her matched voice until another is picked (an unknown pick falls back to it too)', () => {
    expect(backupChoice({ ...info, backupVoice: null })).toBe(MATCHED_VOICE);
    expect(backupChoice({ ...info, backupVoice: 'af_bella' })).toBe('af_bella');
    expect(backupChoice({ ...info, backupVoice: 'mix-1' })).toBe('mix-1');
    expect(backupChoice({ ...info, backupVoice: 'gone' })).toBe(MATCHED_VOICE);
    // A build without her matched voice: Kokoro's default.
    expect(backupChoice({ ...info, voices: voices.filter((x) => x.id !== MATCHED_VOICE), backupVoice: null })).toBe('af_heart');
  });

  it('lists three first: her matched voice, then the best graded, plus the one picked when it isn’t among them', () => {
    expect(recommendedVoices(voices, MATCHED_VOICE)).toEqual(['af_nephis', 'af_heart', 'af_bella']);
    expect(recommendedVoices(voices, 'af_sky')).toEqual(['af_nephis', 'af_heart', 'af_bella', 'af_sky']);
    expect(recommendedVoices(voices, 'mix-1')).toEqual(['af_nephis', 'af_heart', 'af_bella', 'mix-1']);
    expect(recommendedVoices(voices.filter((x) => x.id !== MATCHED_VOICE), 'af_heart')).toEqual(['af_heart', 'af_bella', 'af_nicole']);
  });
});
